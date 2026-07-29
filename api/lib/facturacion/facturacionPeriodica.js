/**
 * Mecánica común de la facturación periódica interna del grupo.
 *
 * Aquí vive **cómo** se factura un periodo, no **qué** se factura: los periodos,
 * el cerrojo de ejecución, la recuperación de meses perdidos, el barrido de
 * reconciliación, el reclamo atómico de cada elemento, la escritura de la
 * factura y el descarte de facturas inválidas. Todo lo que dependa del dominio
 * —qué elementos se seleccionan, cómo se agrupan, qué concepto lleva cada línea,
 * qué marcas se escriben— lo aporta el dominio a través del contrato de abajo.
 *
 * El primer consumidor es la facturación de reparaciones de mantenimiento
 * (`facturarMantenimiento.js`). El diseño está pensado para que quepan sin
 * tocar este módulo:
 * - una sociedad emisora **variable** por grupo (ventas internas: la emisora
 *   depende del almacén que sirvió el pedido), porque el módulo nunca resuelve
 *   la emisora: solo mueve grupos que el dominio ya ha formado;
 * - facturas de importe **negativo** (abonos de rappel), porque la única
 *   comprobación de importe es "total 0 no vale".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRATO DEL DOMINIO
 *
 * `dominio` es un objeto plano con estos campos:
 *
 * - `etiqueta`            prefijo de los logs, p. ej. 'facturar mantenimiento'.
 * - `claves`              `{ pk, sk }` del ítem de configuración en `Igp_Ajustes`.
 * - `cerrojo`             instancia de `crearCerrojo()`.
 * - `leerAjustes()`       configuración del dominio (tolerante a que no exista).
 * - `validarSerie(ajustes)` → `{ ok: true, serieConfig }` | `{ ok: false, status, error }`.
 * - `cargarContexto({ periodo, ajustes })` → maestros y datos que necesite el
 *   plan (locales, empresas, facturas ya existentes del periodo…).
 * - `planificar({ periodo, ajustes, contexto })` → `{ ok: true, grupos, excluidos,
 *   cerrables, ...extra }` | `{ ok: false, status, error }`. Cada grupo es una
 *   factura potencial y debe traer:
 *     · `elementos`: los ítems reclamables, en el orden en que se facturarán;
 *     · `construir(elementos, { idFactura, ejecucion, origen })` →
 *       `{ factura, lineas }` ya con las marcas del dominio, construido **solo**
 *       con los elementos recibidos.
 * - `reconciliacion`      `{ ambitos(contexto), buscarMarcados(ambito, limite),
 *   idFacturaDe(el), ejecucionDe(el), describir(el, ambito) }`.
 * - `liberarElemento(el, idFactura)` → `true` si le quitó la marca.
 * - `reclamarElemento(el, { idFactura, periodo, grupo, ejecucion, fecha })` →
 *   `{ ok }`; `ok: false` significa "cambió desde la lectura, se descarta".
 * - `referencia(el)`      texto corto del elemento para los logs.
 * - `nombreElemento`      cómo se llama un elemento en los logs ('el parte').
 * - `mensajeCerrojoPerdido` error que se registra si el cerrojo pasa a ser de
 *   otra ejecución.
 * - `mensajeCerrojoEnDuda(minutos)` error que se registra cuando el cerrojo no se
 *   ha podido confirmar dentro de la ventana de escritura.
 * - `cerrarSinFactura(el, periodo)` → `true` si lo marcó como cerrado.
 * - `describirCerrado(el)`, `describirDescartado(el, grupo)`,
 *   `describirFacturaCreada({...})`, `identidadGrupo(grupo)`,
 *   `excluirGrupo(motivo, grupo, nElementos, detalle)`.
 * - `usuarioAuditoria`  nombre que firma la auditoría cuando no hay usuario.
 * - `detalleAuditoria({ grupo, factura, reclamados, periodo, ajustes, origen })`.
 * - `construirResumen({...})`  el resumen que se persiste en los ajustes.
 * - `describirPrevisualizacion({...})` y `describirGeneracion({...})`: la forma
 *   pública de la respuesta, que es del dominio y no de este módulo.
 */

import crypto from 'node:crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables, keyForFacturaPrincipalId } from '../db.js';
import { formatId6 } from '../usuarioLocales.js';
import {
  getCifFromEmpresaItem,
  getNombreFromEmpresaItem,
  getIdEmpresaFromItem,
} from '../empresaCif.js';
import { getSerieConfig, errorSerieTipoIncompatible } from './series.js';
import { validarDatosEmision } from './emitirFactura.js';

export function ahoraIso() {
  return new Date().toISOString();
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// ─── Periodos ───

export function periodoValido(periodo) {
  const s = String(periodo ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(s)) return false;
  const mes = Number(s.slice(5, 7));
  return mes >= 1 && mes <= 12;
}

/** Periodo (YYYY-MM) natural de una fecha. */
export function periodoDe(fecha = new Date()) {
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`;
}

export function periodoAnterior(fecha = new Date()) {
  const anio = fecha.getFullYear();
  const mes = fecha.getMonth() + 1;
  return mes === 1 ? `${anio - 1}-12` : `${anio}-${String(mes - 1).padStart(2, '0')}`;
}

export function periodoSiguiente(periodo) {
  const anio = Number(periodo.slice(0, 4));
  const mes = Number(periodo.slice(5, 7));
  return mes === 12 ? `${anio + 1}-01` : `${anio}-${String(mes + 1).padStart(2, '0')}`;
}

/** Último día del periodo (yyyy-mm-dd). Es la fecha de emisión y de operación. */
export function ultimoDiaPeriodo(periodo) {
  const anio = Number(periodo.slice(0, 4));
  const mes = Number(periodo.slice(5, 7));
  // Día 0 del mes siguiente = último día del mes, en UTC para no depender del huso.
  const dias = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${periodo}-${String(dias).padStart(2, '0')}`;
}

/**
 * Corte de selección: se factura lo fechado antes del primer día del mes
 * siguiente al periodo. Con el uso normal (periodo = mes anterior) eso es el
 * primer día del mes en curso, que es el criterio acordado: determinista y con
 * la propiedad de que un elemento fechado tarde no se pierde, simplemente entra
 * en la tanda siguiente.
 *
 * Cuando el campo de corte es un ISO en UTC y la comparación es textual, el
 * corte es a las 00:00 UTC: en horario español (UTC+1/+2) algo registrado el
 * último día del mes a última hora local ya cae en el periodo siguiente y se
 * factura en la tanda siguiente. Es intencionado y no pierde nada.
 */
export function corteSeleccion(periodo) {
  return `${periodoSiguiente(periodo)}-01`;
}

/**
 * Periodos que quedan por generar, en orden, desde el último generado hasta el
 * objetivo (incluido).
 *
 * Sin esto, un hueco de varios meses (servidor caído en enero) metería lo de
 * diciembre en la factura de enero, con fecha de emisión del 31 de enero:
 * diciembre acabaría numerado en el ejercicio siguiente, que es justo lo
 * contrario de anclar la fecha al último día del periodo.
 *
 * Sin último periodo generado no hay referencia con la que reconstruir el
 * histórico y se factura solo el objetivo, que es el comportamiento de siempre.
 * El tope por tanda evita que una configuración antigua dispare decenas de
 * facturaciones seguidas: el resto se recupera en los ciclos siguientes.
 */
export function periodosPendientes(ultimoGenerado, objetivo, maximo = 12) {
  if (!periodoValido(objetivo)) return [];
  if (!periodoValido(ultimoGenerado)) return [objetivo];
  if (ultimoGenerado >= objetivo) return [];
  const lista = [];
  let periodo = periodoSiguiente(ultimoGenerado);
  while (periodo <= objetivo && lista.length < maximo) {
    lista.push(periodo);
    periodo = periodoSiguiente(periodo);
  }
  return lista;
}

/**
 * Solo se facturan **periodos cerrados**: el mes en curso no vale.
 *
 * Facturar el mes en marcha parece inofensivo y no lo es. La fecha de emisión de
 * estos documentos es el último día del periodo, así que un 27 de julio saldría
 * una factura fechada el 31 de julio: fecha futura, con su número fiscal
 * consumido y su huella VERI*FACTU. Peor todavía, el reclamo pone la marca de
 * facturación en todo lo completado hasta ese momento y `api/routes/pedidos.js`
 * congela lo marcado, así que el almacén se quedaría sin poder tocar sus líneas
 * durante el resto del mes. Y lo que entrase después solo se recuperaría
 * regenerando el periodo, que crea un segundo documento para el mismo par de
 * sociedades.
 *
 * El criterio vale igual para los tres flujos —mercancía, rappel y
 * mantenimiento—: los tres fechan al último día del periodo y los tres congelan
 * lo que reclaman.
 *
 * @param {{ soloConsulta?: boolean }} [opciones] — con `soloConsulta: true` (previsualización)
 *   se admite el mes en curso para consultar el avance; la generación sigue exigiendo mes cerrado.
 * @returns {{ ok: false, status: number, error: string } | null}
 */
export function comprobarPeriodo(periodo, { soloConsulta = false } = {}) {
  if (!periodoValido(periodo)) {
    return { ok: false, status: 400, error: 'El periodo debe tener el formato AAAA-MM' };
  }
  const enCurso = periodoDe();
  if (periodo > enCurso) {
    return { ok: false, status: 400, error: 'No se puede facturar un periodo futuro' };
  }
  if (periodo === enCurso && !soloConsulta) {
    return {
      ok: false,
      status: 400,
      error:
        'Solo se pueden facturar periodos cerrados: el mes en curso todavía no ha terminado.' +
        ' Facturarlo emitiría documentos con fecha futura y bloquearía los pedidos del resto del mes.',
    };
  }
  return null;
}

// ─── Concurrencia ───

/**
 * Antigüedad mínima de la marca de facturación para que el barrido libere un
 * elemento cuya factura no existe. El margen evita pisar una ejecución en curso,
 * que escribe primero los elementos y la factura al final.
 */
export const MARGEN_RECONCILIACION_MS = 30 * 60 * 1000;
/**
 * Caducidad del cerrojo. Debe superar el margen de reconciliación: si caducara
 * antes, otra ejecución podría tomar el cerrojo, dar por huérfanos los elementos
 * de una ejecución que sigue viva y facturarlos por segunda vez. La ejecución
 * renueva el cerrojo mientras trabaja, así que la caducidad solo se alcanza si
 * el proceso muere.
 */
export const CERROJO_TTL_MS = MARGEN_RECONCILIACION_MS + 5 * 60 * 1000;
/** Cada cuánto se renueva el cerrojo de una ejecución viva. */
export const CERROJO_RENOVACION_MS = 2 * 60 * 1000;
/**
 * Antigüedad máxima de la última renovación **confirmada** para poder escribir
 * una factura.
 *
 * Nadie puede tomar el cerrojo antes de `expira_en`, y `expira_en` es siempre la
 * última confirmación más la caducidad. Así que mientras la confirmación esté a
 * menos de `CERROJO_TTL_MS` el cerrojo sigue siendo nuestro con certeza, aunque
 * la renovación de ahora mismo no haya podido comprobarse. La ventana se queda
 * cinco periodos de renovación por debajo de esa cota:
 *
 * - **Por abajo**: son 12 renovaciones seguidas, así que hacen falta 25 minutos
 *   de DynamoDB inalcanzable para abortar una tanda legítima. Un corte
 *   momentáneo —o varios— no la para: la comprobación previa a cada factura cae
 *   sobre la confirmación del latido, que como mucho tiene dos minutos.
 * - **Por arriba**: deja 10 minutos de holgura frente a la caducidad para el
 *   desfase de reloj entre servidores (el `expira_en` lo compara DynamoDB contra
 *   la hora del otro proceso) y para lo que tarde la escritura que viene
 *   después. Además queda por debajo del margen de reconciliación, así que ni
 *   con un reloj adelantado el barrido ajeno alcanzaría a nuestras marcas.
 */
export const CERROJO_VENTANA_ESCRITURA_MS = CERROJO_TTL_MS - 5 * CERROJO_RENOVACION_MS;

/**
 * Cerrojo de ejecución de un dominio, guardado como un ítem más de
 * `Igp_Ajustes` (mismo PK que su configuración, para tenerlo a la vista).
 *
 * `mensajeOcupado(desde)` construye el error del 409 y recibe el sufijo
 * " (empezó hace N min)" ya formateado, o cadena vacía si no se pudo leer.
 */
export function crearCerrojo({ pk, sk, etiqueta, mensajeOcupado }) {
  const Key = { PK: pk, SK: sk };
  /**
   * Instante de la última renovación confirmada de cada ejecución. Se apunta el
   * momento **anterior** al envío, que es el que se usó para calcular
   * `expira_en`: apuntar el de la respuesta daría por buena una ventana algo más
   * larga que la caducidad real.
   */
  const confirmado = new Map();

  async function adquirir(ejecucion, origen) {
    const ahora = Date.now();
    const iniciado = new Date(ahora).toISOString();
    try {
      await docClient.send(
        new PutCommand({
          TableName: tables.ajustes,
          Item: {
            PK: pk,
            SK: sk,
            ejecucion,
            origen,
            iniciado_en: iniciado,
            expira_en: new Date(ahora + CERROJO_TTL_MS).toISOString(),
          },
          // Un cerrojo caducado (proceso muerto) no debe bloquear para siempre, y
          // uno antiguo sin `expira_en` tampoco.
          ConditionExpression:
            'attribute_not_exists(PK) OR attribute_not_exists(expira_en) OR expira_en < :ahora',
          ExpressionAttributeValues: { ':ahora': iniciado },
        })
      );
      confirmado.set(ejecucion, ahora);
      return { ok: true };
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      let desde = '';
      try {
        const r = await docClient.send(new GetCommand({ TableName: tables.ajustes, Key }));
        const inicio = Date.parse(r.Item?.iniciado_en ?? '');
        if (Number.isFinite(inicio)) {
          const minutos = Math.max(0, Math.round((Date.now() - inicio) / 60000));
          desde = minutos === 0 ? ' (empezó hace menos de un minuto)' : ` (empezó hace ${minutos} min)`;
        }
      } catch {
        // El mensaje sin el "hace cuánto" sigue siendo útil.
      }
      return { ok: false, status: 409, error: mensajeOcupado(desde) };
    }
  }

  /**
   * Renueva el cerrojo de una ejecución viva y, a la vez, comprueba que sigue
   * siendo suyo: la condición solo se cumple si nadie lo ha tomado.
   *
   * Tres estados, porque no son lo mismo:
   * - `'mio'`: renovación confirmada. Es el único que apunta la confirmación.
   * - `'perdido'`: el cerrojo ya es de otra ejecución, o alguien lo ha borrado.
   * - `'duda'`: no se ha podido hablar con DynamoDB. Un fallo de red **no**
   *   prueba que se haya perdido el cerrojo, así que la tanda no se aborta por un
   *   corte momentáneo; se registra y se reintenta en el latido siguiente. Lo que
   *   este estado no hace es autorizar a escribir: eso lo decide la antigüedad de
   *   la última confirmación (ver `confirmarParaEscribir`).
   * @returns {Promise<'mio' | 'perdido' | 'duda'>}
   */
  async function renovar(ejecucion) {
    const ahora = Date.now();
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: tables.ajustes,
          Key,
          UpdateExpression: 'SET expira_en = :exp, renovado_en = :ahora',
          ConditionExpression: 'ejecucion = :eje',
          ExpressionAttributeValues: {
            ':exp': new Date(ahora + CERROJO_TTL_MS).toISOString(),
            ':ahora': new Date(ahora).toISOString(),
            ':eje': ejecucion,
          },
        })
      );
      confirmado.set(ejecucion, ahora);
      return 'mio';
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') {
        confirmado.delete(ejecucion);
        return 'perdido';
      }
      console.warn(`[${etiqueta}] No se pudo renovar el cerrojo:`, err?.message || err);
      return 'duda';
    }
  }

  /**
   * ¿Se puede escribir un documento contable ahora mismo?
   *
   * Se renueva el cerrojo y se exige una confirmación reciente. La diferencia con
   * mirar solo el resultado de la renovación está en el estado de duda: un fallo
   * de red no demuestra que hayamos perdido el cerrojo, pero tampoco demuestra
   * que lo conservemos, y es exactamente el escenario en el que se pierde. Si el
   * corte se alarga, el cerrojo caduca de verdad, otra ejecución lo toma, su
   * barrido libera nuestras marcas y las factura: dos facturas con lo mismo
   * dentro. Por eso la duda solo vale mientras la última renovación confirmada
   * siga dentro de la ventana.
   *
   * @returns {Promise<{ ok: true } | { ok: false, motivo: 'perdido' | 'duda', minutos: number }>}
   */
  async function confirmarParaEscribir(ejecucion) {
    const estado = await renovar(ejecucion);
    if (estado === 'mio') return { ok: true };
    if (estado === 'perdido') return { ok: false, motivo: 'perdido', minutos: 0 };
    const ultima = confirmado.get(ejecucion);
    const desde = Number.isFinite(ultima) ? Date.now() - ultima : Number.POSITIVE_INFINITY;
    if (desde < CERROJO_VENTANA_ESCRITURA_MS) return { ok: true };
    const minutos = Number.isFinite(desde) ? Math.round(desde / 60000) : 0;
    console.warn(
      `[${etiqueta}] Cerrojo sin confirmar desde hace ${minutos} min: se para antes de escribir la factura`
    );
    return { ok: false, motivo: 'duda', minutos };
  }

  /**
   * ¿Hay una generación en vuelo? Lo usa el trabajo programado para no disparar
   * una petición cada minuto que rebotaría con 409 y marcaría fallo.
   */
  async function hayEnCurso() {
    try {
      const r = await docClient.send(new GetCommand({ TableName: tables.ajustes, Key }));
      const expira = r.Item?.expira_en;
      if (typeof expira !== 'string' || expira === '') return false;
      return expira > ahoraIso();
    } catch (err) {
      // Ante la duda, no bloquear el trabajo: el cerrojo real se comprueba al generar.
      console.warn(`[${etiqueta}] No se pudo leer el cerrojo:`, err?.message || err);
      return false;
    }
  }

  async function liberar(ejecucion) {
    try {
      await docClient.send(
        new DeleteCommand({
          TableName: tables.ajustes,
          Key,
          // No borrar el cerrojo de otra ejecución que lo haya tomado tras caducar.
          ConditionExpression: 'ejecucion = :eje',
          ExpressionAttributeValues: { ':eje': ejecucion },
        })
      );
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') {
        console.warn(`[${etiqueta}] No se pudo liberar el cerrojo:`, err?.message || err);
      }
    } finally {
      confirmado.delete(ejecucion);
    }
  }

  return { adquirir, renovar, confirmarParaEscribir, hayEnCurso, liberar };
}

// ─── Ajustes ───

/**
 * Configuración de una facturación periódica. Tolerante a que el ítem no exista
 * o a que la lectura falle: en ese caso, valores por defecto (con la generación
 * automática desactivada, que es como nace).
 *
 * Los campos comunes (serie, día y hora de generación, condiciones de pago,
 * activación y último periodo generado) los normaliza este módulo; `extra`
 * añade los del dominio y recibe el ítem crudo.
 *
 * `campoSerie` existe porque un dominio puede guardar más de una serie en el
 * mismo ítem y ninguna llamarse `serie`: las ventas internas tienen
 * `serie_ventas` para la mercancía y `serie_rappel` para los abonos. Se resuelve
 * aquí y no en `extra` porque la serie se normaliza después de mezclarlo.
 *
 * `campoUltimoPeriodo` va en la misma línea: dos dominios pueden compartir el
 * ítem de ajustes (misma serie de pantalla, mismo día y hora) pero necesitan
 * marcadores de último periodo **separados**, o uno daría por generado el mes que
 * solo generó el otro. Ver `facturarRappel.js`.
 *
 * @param {{ pk: string, sk: string, etiqueta: string, defecto: object,
 *           extra?: (item: object, defecto: object) => object,
 *           campoSerie?: string, campoUltimoPeriodo?: string }} params
 */
export async function leerAjustesPeriodicos({
  pk,
  sk,
  etiqueta,
  defecto,
  extra,
  campoSerie = 'serie',
  campoUltimoPeriodo = 'ultimo_periodo_generado',
}) {
  let item = null;
  try {
    const r = await docClient.send(
      new GetCommand({ TableName: tables.ajustes, Key: { PK: pk, SK: sk } })
    );
    item = r.Item || null;
  } catch (err) {
    console.warn(`[${etiqueta}] No se pudieron leer los ajustes:`, err?.message || err);
    return { ...defecto };
  }
  if (!item) return { ...defecto };

  const serie = String(item[campoSerie] ?? '').trim();
  const dia = Number.parseInt(String(item.dia_generacion ?? '').trim(), 10);
  const hora = String(item.hora ?? '').trim();
  return {
    ...defecto,
    ...(extra ? extra(item, defecto) : {}),
    serie: serie || defecto.serie,
    dia_generacion: Number.isFinite(dia) && dia >= 1 && dia <= 31 ? dia : defecto.dia_generacion,
    hora: /^([01]\d|2[0-3]):[0-5]\d$/.test(hora) ? hora : defecto.hora,
    condiciones_pago: String(item.condiciones_pago ?? ''),
    enabled: item.Enabled === true,
    ultimo_periodo_generado: String(item[campoUltimoPeriodo] ?? '').trim(),
  };
}

/**
 * Deja constancia del último periodo generado en la propia configuración. Es lo
 * que permite al trabajo programado recuperar un mes perdido si el servidor
 * estuvo apagado a la hora prevista.
 *
 * El marcador solo avanza: una generación manual de un periodo antiguo deja
 * constancia de la ejecución, pero no puede hacer retroceder el marcador y
 * provocar que el trabajo automático rehaga meses ya cerrados.
 *
 * `sufijo` separa los marcadores de dos dominios que comparten el mismo ítem de
 * ajustes. Vacío por defecto para que los nombres de campo de los dominios que
 * ya existían no cambien: la pantalla de ajustes los lee tal cual.
 */
export async function marcarPeriodoGenerado({ pk, sk, sufijo = '' }, periodo, resumen = {}) {
  const campoPeriodo = `ultimo_periodo_generado${sufijo}`;
  const campoFecha = `ultima_generacion${sufijo}`;
  const campoFechaPeriodo = `ultima_generacion_periodo${sufijo}`;
  const campoResumen = `ultima_generacion_resumen${sufijo}`;
  const fecha = ahoraIso();
  const res = JSON.stringify(resumen);
  const setGeneracion =
    `${campoFecha} = :fecha, ${campoFechaPeriodo} = :per, ${campoResumen} = :res, updatedAt = :fecha`;
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tables.ajustes,
        Key: { PK: pk, SK: sk },
        UpdateExpression: `SET ${campoPeriodo} = :per, ${setGeneracion}`,
        ConditionExpression: `attribute_not_exists(${campoPeriodo}) OR ${campoPeriodo} <= :per`,
        ExpressionAttributeValues: { ':per': periodo, ':fecha': fecha, ':res': res },
      })
    );
    return;
  } catch (err) {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
  }
  await docClient.send(
    new UpdateCommand({
      TableName: tables.ajustes,
      Key: { PK: pk, SK: sk },
      UpdateExpression: `SET ${setGeneracion}`,
      ExpressionAttributeValues: { ':per': periodo, ':fecha': fecha, ':res': res },
    })
  );
}

/**
 * Estado del último intento del trabajo automático. Se persiste para que un
 * fallo no se quede solo en el log del servidor: la pantalla de ajustes dice
 * que la generación está activa y el usuario necesita poder ver que no lo está
 * consiguiendo (falta el secreto interno, la serie no sirve, etc.).
 */
export async function marcarIntentoGeneracion({ pk, sk, sufijo = '' }, { periodo = '', estado, mensaje = '' }) {
  await docClient.send(
    new UpdateCommand({
      TableName: tables.ajustes,
      Key: { PK: pk, SK: sk },
      UpdateExpression:
        `SET ultimo_intento_en${sufijo} = :fecha, ultimo_intento_estado${sufijo} = :est,` +
        ` ultimo_intento_periodo${sufijo} = :per, ultimo_intento_mensaje${sufijo} = :msg, updatedAt = :fecha`,
      ExpressionAttributeValues: {
        ':fecha': ahoraIso(),
        ':est': String(estado ?? ''),
        ':per': String(periodo ?? ''),
        ':msg': String(mensaje ?? ''),
      },
    })
  );
}

// ─── Lectura de maestros ───

/**
 * `ExpressionAttributeNames` hace falta para proyectar atributos cuyo nombre no
 * es un identificador válido en una expresión: el maestro de locales guarda los
 * almacenes del local en `almacen origen`, con espacio.
 */
export async function scanTodo(TableName, ProjectionExpression, ExpressionAttributeNames) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new ScanCommand({
        TableName,
        ...(ProjectionExpression && { ProjectionExpression }),
        ...(ExpressionAttributeNames && { ExpressionAttributeNames }),
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Datos fiscales de una sociedad del grupo tal como los espera la cabecera de la
 * factura, tanto si emite como si recibe.
 *
 * Vive aquí porque lo comparten los generadores periódicos: sin domicilio,
 * código postal, municipio y provincia la factura es defectuosa y así se
 * enviaría a VERI*FACTU, y ese es un error que ninguna validación delata. Los
 * nombres de campo se leen con los helpers tolerantes al casing del maestro.
 */
export function datosEmpresaFiscal(item) {
  return {
    id: formatId6(getIdEmpresaFromItem(item)),
    nombre: getNombreFromEmpresaItem(item),
    cif: String(getCifFromEmpresaItem(item) ?? '').trim(),
    direccion: String(item?.Direccion ?? item?.direccion ?? ''),
    cp: String(item?.Cp ?? item?.cp ?? ''),
    municipio: String(item?.Municipio ?? item?.municipio ?? ''),
    provincia: String(item?.Provincia ?? item?.provincia ?? ''),
    email: String(item?.Email ?? item?.email ?? ''),
    iban: String(item?.Iban ?? item?.iban ?? '').trim(),
    iban_alternativo: String(item?.IbanAlternativo ?? '').trim(),
  };
}

/**
 * Maestro de empresas indexado por `id_empresa` con el padding a 6 dígitos que
 * usan locales y empresas. Sin proyección a propósito: el CIF y el nombre se
 * leen con helpers tolerantes al casing y una proyección los perdería.
 */
export async function cargarEmpresasPorId() {
  const items = await scanTodo(tables.empresas);
  const porId = new Map();
  for (const e of items) {
    const idRaw = getIdEmpresaFromItem(e).trim();
    if (!idRaw) continue;
    const id = formatId6(idRaw);
    if (id === '000000') continue;
    porId.set(id, e);
  }
  return porId;
}

// ─── Series ───

/**
 * Comprueba la serie una sola vez y antes de tocar nada: si no sirve, la
 * ejecución entera se aborta sin haber reclamado ningún elemento.
 *
 * `textoConfig` completa el mensaje del 404 con el nombre de la configuración
 * del dominio, que es lo que el usuario tiene que ir a corregir.
 * @returns {Promise<{ ok: true, serieConfig: object } | { ok: false, status: number, error: string }>}
 */
export async function validarSerie(serie, { tipo = 'OUT', textoConfig, etiquetaProceso } = {}) {
  const serieConfig = await getSerieConfig(serie);
  if (!serieConfig) {
    return {
      ok: false,
      status: 404,
      error: `La serie "${serie}" no existe. Créala en Facturación → Series o corrige ${textoConfig}.`,
    };
  }
  if (serieConfig.activa === false) {
    return {
      ok: false,
      status: 400,
      error: `La serie "${serie}" está inactiva: actívala para poder facturar ${etiquetaProceso}.`,
    };
  }
  const errorTipo = errorSerieTipoIncompatible(serieConfig, tipo);
  if (errorTipo) return { ok: false, status: 400, error: errorTipo };
  return { ok: true, serieConfig };
}

// ─── Facturas ───

async function facturaExiste(idFactura, etiqueta) {
  try {
    const r = await docClient.send(
      new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(idFactura) })
    );
    return !!r.Item;
  } catch (err) {
    // Ante la duda, se considera que existe: liberar un elemento cuya factura sí
    // está sería facturarlo dos veces.
    console.warn(`[${etiqueta}] No se pudo comprobar la factura`, idFactura, err?.message || err);
    return true;
  }
}

/**
 * Facturas ya creadas por un dominio para un periodo, agrupadas por la clave que
 * el dominio use para decidir "ya hay factura de esto".
 *
 * @param {{ campoPeriodo: string, periodo: string, clave: (factura: object) => string }} params
 * @returns {Promise<Map<string, object[]>>}
 */
export async function facturasDelPeriodo({ campoPeriodo, periodo, clave }) {
  const items = await scanTodo(tables.facturas);
  const porClave = new Map();
  for (const f of items) {
    if (String(f[campoPeriodo] ?? '').trim() !== periodo) continue;
    const k = clave(f);
    const lista = porClave.get(k) || [];
    lista.push({
      id_factura: String(f.id_factura ?? f.id_entrada ?? ''),
      numero_factura: String(f.numero_factura ?? ''),
      estado: String(f.estado ?? ''),
      total_factura: Number(f.total_factura ?? 0),
    });
    porClave.set(k, lista);
  }
  return porClave;
}

/**
 * Borra las líneas ya escritas de una factura cuya cabecera no ha llegado a
 * guardarse: sin esto quedarían colgando de un identificador de factura que no
 * existe, y el barrido solo repara los elementos facturados.
 */
async function borrarLineasFactura(lineas, etiqueta) {
  for (const l of lineas) {
    try {
      await docClient.send(
        new DeleteCommand({
          TableName: tables.facturasLineas,
          Key: { id_factura: l.id_factura, id_linea: l.id_linea },
        })
      );
    } catch (err) {
      console.error(
        `[${etiqueta}] No se pudo borrar la línea huérfana`,
        l.id_factura,
        l.id_linea,
        err?.message || err
      );
    }
  }
}

/**
 * Entrada de auditoría de la factura. Se escribe aquí (y no se reutiliza la del
 * router) porque estos módulos se usan también desde el trabajo programado y
 * desde los scripts, sin pasar por Express.
 */
async function registrarAuditoriaFactura(idFactura, usuarioId, usuarioNombre, detalle, { etiqueta, usuarioPorDefecto }) {
  try {
    await docClient.send(
      new PutCommand({
        TableName: tables.facturasAuditoria,
        Item: {
          id_entrada: `AUD-${idFactura}-${Date.now()}`,
          id_factura: idFactura,
          timestamp_accion: ahoraIso(),
          accion: 'creacion',
          usuario_id: usuarioId || '',
          usuario_nombre: usuarioNombre || usuarioPorDefecto,
          detalle: JSON.stringify(detalle || {}),
        },
      })
    );
  } catch (err) {
    // La auditoría no debe tumbar una factura ya escrita.
    console.warn(`[${etiqueta}] No se pudo auditar la factura`, idFactura, err?.message || err);
  }
}

// ─── Escrituras sobre los elementos facturados ───

/**
 * Testigo de que el importe leído sigue vigente.
 *
 * La fecha del elemento no basta: una reescritura de sus líneas puede cambiar el
 * importe sin tocarla —a veces no puede tocarla, porque tiene significado fiscal
 * y es el criterio de corte del periodo—. El contador de revisión sube con ADD en
 * toda escritura de las líneas y es el único que detecta ese caso.
 *
 * Los elementos anteriores al contador no tienen el atributo; ahí el testigo es
 * su ausencia, que la primera escritura ya rompe.
 */
export function condicionRevision(elemento, campo) {
  const rev = Number(elemento?.[campo]);
  if (Number.isFinite(rev)) {
    return { expresion: `${campo} = :revLeida`, valores: { ':revLeida': rev } };
  }
  return { expresion: `attribute_not_exists(${campo})`, valores: {} };
}

async function liberarElementos(dominio, elementos, idFactura) {
  const liberados = [];
  for (const el of elementos) {
    try {
      if (await dominio.liberarElemento(el, idFactura)) liberados.push(el);
    } catch (err) {
      // El barrido de reconciliación lo arreglará en la siguiente ejecución.
      console.error(
        `[${dominio.etiqueta}] No se pudo liberar ${dominio.nombreElemento}`,
        dominio.referencia(el),
        err?.message || err
      );
    }
  }
  return liberados;
}

/**
 * Libera los elementos marcados con una factura que ya no existe.
 *
 * Cubre dos casos con una sola pieza: que una ejecución se cayera después de
 * reclamar los elementos y antes de escribir la factura, y que el usuario anulara
 * el borrador, porque anular un borrador lo borra físicamente. Una factura
 * emitida y anulada después sigue existiendo con estado 'anulada' y sus elementos
 * siguen marcados: ahí toca rectificativa, no volver a facturar.
 *
 * `ejecucionPropia` protege los elementos de la ejecución que tiene el cerrojo:
 * es la única que puede estar escribiendo ahora mismo, y liberarle un elemento
 * acabaría en dos facturas con lo mismo dentro.
 */
export async function reconciliarElementosHuerfanos(dominio, contexto, { ejecucionPropia = '' } = {}) {
  const { ambitos, buscarMarcados, idFacturaDe, ejecucionDe, describir } = dominio.reconciliacion;
  const limite = new Date(Date.now() - MARGEN_RECONCILIACION_MS).toISOString();
  const existePorFactura = new Map();
  const liberados = [];
  for (const ambito of ambitos(contexto)) {
    const marcados = await buscarMarcados(ambito, limite);
    for (const el of marcados) {
      const idFactura = idFacturaDe(el);
      if (!idFactura) continue;
      if (ejecucionPropia && ejecucionDe(el) === ejecucionPropia) continue;
      if (!existePorFactura.has(idFactura)) {
        existePorFactura.set(idFactura, await facturaExiste(idFactura, dominio.etiqueta));
      }
      if (existePorFactura.get(idFactura)) continue;
      try {
        if (await dominio.liberarElemento(el, idFactura)) {
          liberados.push(describir(el, ambito));
        }
      } catch (err) {
        console.error(
          `[${dominio.etiqueta}] Barrido: no se pudo liberar`,
          dominio.referencia(el),
          err?.message || err
        );
      }
    }
  }
  return liberados;
}

// ─── Orquestación ───

/**
 * Previsualización: qué se facturaría del periodo, sin escribir nada.
 *
 * La serie se valida también aquí para que la pantalla avise antes de que el
 * usuario le dé al botón de generar.
 * @returns {Promise<object>} lo que devuelva `dominio.describirPrevisualizacion`
 *   o `{ ok: false, status, error }`
 */
export async function previsualizarPeriodo(dominio, { periodo } = {}) {
  const objetivo = periodo || periodoAnterior();
  const guard = comprobarPeriodo(objetivo, { soloConsulta: true });
  if (guard) return guard;

  const ajustes = await dominio.leerAjustes();
  const serie = await dominio.validarSerie(ajustes);
  if (!serie.ok) return serie;

  const contexto = await dominio.cargarContexto({ periodo: objetivo, ajustes });
  const plan = await dominio.planificar({ periodo: objetivo, ajustes, contexto });
  if (!plan.ok) return plan;

  return dominio.describirPrevisualizacion({ periodo: objetivo, ajustes, contexto, plan });
}

/**
 * ¿Ha quedado algo fuera de la tanda? Devuelve el motivo, o cadena vacía si el
 * periodo se ha facturado entero.
 *
 * Esto es lo que define qué significa **"el periodo está generado"**, y de ello
 * depende que el trabajo programado vuelva a intentarlo. El criterio es: el
 * periodo está generado cuando no ha quedado pendiente nada que debiera haberse
 * facturado. Tres cosas lo dejan pendiente:
 *
 * - `interrumpida`: la tanda se paró a medias (cerrojo perdido o en duda).
 * - `errores`: una factura no se pudo escribir (throttling de DynamoDB, un
 *   fallo de red). Sus elementos quedaron liberados, así que siguen sin facturar.
 * - `descartados`: un elemento cambió entre el plan y el reclamo. Con la lectura
 *   fresca de la tanda siguiente entrará sin problema.
 *
 * Lo que **no** cuenta son los `excluidos`. Un excluido no es un fallo de la
 * tanda: es un dato que impide facturar y que se explica en el informe (una
 * sociedad sin CIF, un almacén no atribuible, un IVA indeterminable). Si
 * bloquearan el marcador, un solo local sin sociedad asignada dejaría el periodo
 * eternamente "no generado" y el trabajo automático lo reintentaría cada media
 * hora para siempre sin que nada cambiara.
 *
 * Reintentar es seguro y barato: cada elemento facturado lleva su marca y la
 * selección los descarta, así que la tanda siguiente solo recoge lo que quedó
 * fuera. Cuando lo consigue, el periodo se marca y el trabajo avanza solo.
 *
 * La alternativa —marcar el periodo y seguir— es la que había, y deja el mes a
 * medias sin que nada vuelva a mirarlo: el `errores: 1` se quedaba dentro de un
 * JSON y el log decía "OK". En facturación, quedarse atascado de forma visible es
 * mejor que avanzar dejando un agujero.
 */
export function motivoIncompleto({ interrumpida, errores = [], descartados = [] }) {
  if (interrumpida) return 'interrumpida';
  if (errores.length > 0) return 'errores_de_escritura';
  if (descartados.length > 0) return 'elementos_descartados';
  return '';
}

/**
 * Aviso para los scripts cuando la tanda no ha cerrado el periodo. Vive aquí
 * porque el criterio de "incompleta" es de este módulo y los tres scripts deben
 * contar lo mismo: un fallo parcial que solo se ve en un JSON no se ve.
 *
 * @returns {string} texto a imprimir, o cadena vacía si el periodo quedó cerrado
 */
export function avisoTandaIncompleta(resultado, nombreDocumento = 'factura') {
  if (!resultado?.parcial) return '';
  const nErrores = resultado.errores?.length ?? 0;
  const nDescartados = resultado.descartados?.length ?? 0;
  const partes = [];
  if (resultado.interrumpida) {
    partes.push('la tanda se interrumpió porque otra generación tomó el cerrojo');
  }
  if (nErrores > 0) {
    partes.push(`${nErrores} ${nErrores === 1 ? 'documento no se pudo escribir' : 'documentos no se pudieron escribir'}`);
  }
  if (nDescartados > 0) {
    partes.push(`${nDescartados} elemento(s) cambiaron durante la tanda y se descartaron`);
  }
  return (
    `\nATENCIÓN: el periodo ha quedado INCOMPLETO (${resultado.motivo_incompleto || 'motivo no indicado'}).` +
    `\n  ${partes.join('; ')}.` +
    `\n  Se han escrito ${resultado.total_facturas ?? 0} ${nombreDocumento}(s), pero el periodo NO se ha marcado` +
    '\n  como generado: la tanda siguiente lo reintentará y recogerá solo lo que quedó fuera.' +
    '\n  Revisa los errores de arriba antes de volver a lanzarla.'
  );
}

/**
 * Genera las facturas del periodo en estado borrador.
 *
 * Orden de escritura por grupo: identificador de factura → reclamo de los
 * elementos → líneas → ítem de factura al final, que es cuando se vuelve
 * visible. Así el único fallo posible es el inverso (elementos reclamados sin
 * factura), que el barrido de reconciliación repara.
 *
 * Mientras dura, la ejecución renueva su cerrojo y lo comprueba antes de escribir
 * cada factura: si lo ha perdido, se para en vez de escribir sobre lo que esté
 * haciendo la ejecución que lo tenga.
 *
 * @returns {Promise<object>} lo que devuelva `dominio.describirGeneracion` o
 *   `{ ok: false, status, error }`
 */
export async function generarPeriodo(
  dominio,
  { periodo, usuario_id = '', usuario_nombre = '', origen = 'manual' } = {}
) {
  const objetivo = periodo || periodoAnterior();
  const guard = comprobarPeriodo(objetivo);
  if (guard) return guard;

  const ajustes = await dominio.leerAjustes();
  // La serie se valida antes de reclamar ningún elemento: si no sirve, no tiene
  // sentido empezar.
  const serie = await dominio.validarSerie(ajustes);
  if (!serie.ok) return serie;

  const ejecucion = crypto.randomUUID();
  const cerrojo = await dominio.cerrojo.adquirir(ejecucion, origen);
  if (!cerrojo.ok) return cerrojo;

  // Recorrer los maestros y la tabla de facturas puede pasar de la caducidad del
  // cerrojo: el latido lo mantiene vivo para que otra ejecución no dé por
  // huérfanos unos elementos que se están facturando. Además es el que refresca la
  // última confirmación, que es lo que autoriza a escribir cada factura.
  const latido = setInterval(() => {
    dominio.cerrojo.renovar(ejecucion).catch(() => {});
  }, CERROJO_RENOVACION_MS);
  latido.unref?.();

  try {
    const contexto = await dominio.cargarContexto({ periodo: objetivo, ajustes });

    const liberados = await reconciliarElementosHuerfanos(dominio, contexto, {
      ejecucionPropia: ejecucion,
    });

    const plan = await dominio.planificar({ periodo: objetivo, ajustes, contexto });
    if (!plan.ok) return plan;

    const creadas = [];
    const descartados = [];
    const excluidos = [...plan.excluidos];
    const errores = [];
    let interrumpida = false;

    for (const grupo of plan.grupos) {
      const idFactura = crypto.randomUUID();
      const reclamados = [];
      for (const elemento of grupo.elementos) {
        const r = await dominio.reclamarElemento(elemento, {
          idFactura,
          periodo: objetivo,
          grupo,
          ejecucion,
          // La marca se fecha al reclamar, no al arrancar la tanda: su antigüedad
          // es lo que el barrido usa para decidir si el elemento está huérfano.
          fecha: ahoraIso(),
        });
        if (r.ok) {
          reclamados.push(elemento);
        } else {
          descartados.push(dominio.describirDescartado(elemento, grupo));
        }
      }
      if (reclamados.length === 0) {
        // Todos los elementos del grupo cambiaron entre el plan y el reclamo. Van
        // uno a uno en `descartados`, pero conviene ver en el log que un grupo
        // entero se quedó sin factura.
        console.warn(
          `[${dominio.etiqueta}] Ningún elemento pudo reclamarse: el grupo se queda sin factura`,
          dominio.identidadGrupo(grupo)
        );
        continue;
      }

      // La factura se rehace con los elementos realmente reclamados: si alguno se
      // ha caído del lote, sus importes no pueden quedarse en la cabecera.
      const { factura, lineas } = grupo.construir(reclamados, { idFactura, ejecucion, origen });

      const erroresEmision = validarDatosEmision(factura, lineas);
      if (factura.total_factura === 0 || erroresEmision.length > 0) {
        await liberarElementos(dominio, reclamados, idFactura);
        excluidos.push(
          dominio.excluirGrupo(
            factura.total_factura === 0 ? 'factura_total_cero' : 'validacion_emision',
            grupo,
            reclamados.length,
            erroresEmision.join(' · ')
          )
        );
        continue;
      }

      // Última comprobación antes del documento contable: si otra ejecución tiene
      // el cerrojo, puede haber liberado y reclamado estos mismos elementos, y
      // escribir ahora daría dos facturas con lo mismo dentro. No basta con que la
      // renovación no falle: hace falta una confirmación reciente.
      const permiso = await dominio.cerrojo.confirmarParaEscribir(ejecucion);
      if (!permiso.ok) {
        await liberarElementos(dominio, reclamados, idFactura);
        interrumpida = true;
        errores.push({
          ...dominio.identidadGrupo(grupo),
          error:
            permiso.motivo === 'perdido'
              ? dominio.mensajeCerrojoPerdido
              : dominio.mensajeCerrojoEnDuda(permiso.minutos),
        });
        break;
      }

      try {
        for (const linea of lineas) {
          await docClient.send(new PutCommand({ TableName: tables.facturasLineas, Item: linea }));
        }
        await docClient.send(new PutCommand({ TableName: tables.facturas, Item: factura }));
      } catch (err) {
        console.error(
          `[${dominio.etiqueta}] Error al escribir la factura`,
          idFactura,
          err?.message || err
        );
        await liberarElementos(dominio, reclamados, idFactura);
        // Si lo que falló fue la cabecera, las líneas ya escritas quedarían
        // colgando de una factura que no existe.
        await borrarLineasFactura(lineas, dominio.etiqueta);
        errores.push({
          ...dominio.identidadGrupo(grupo),
          error: err?.message || 'Error al escribir la factura',
        });
        continue;
      }

      await registrarAuditoriaFactura(
        idFactura,
        usuario_id,
        usuario_nombre,
        dominio.detalleAuditoria({ grupo, factura, reclamados, periodo: objetivo, ajustes, origen }),
        { etiqueta: dominio.etiqueta, usuarioPorDefecto: dominio.usuarioAuditoria }
      );

      creadas.push(
        dominio.describirFacturaCreada({
          idFactura,
          grupo,
          factura,
          lineas,
          reclamados,
          ajustes,
          contexto,
          plan,
        })
      );
    }

    // Los elementos que nunca podrán facturarse se cierran para que dejen de
    // girar. Se hace al final: si la tanda se interrumpió, mejor volver a
    // evaluarlos.
    const cerrados = [];
    if (!interrumpida) {
      for (const elemento of plan.cerrables) {
        if (await dominio.cerrarSinFactura(elemento, objetivo)) {
          cerrados.push(dominio.describirCerrado(elemento));
        }
      }
    }

    const incompleta = motivoIncompleto({ interrumpida, errores, descartados });

    const resumen = dominio.construirResumen({
      creadas,
      excluidos,
      descartados,
      cerrados,
      errores,
      origen,
      ejecucion,
      ...(incompleta && { parcial: true, motivo_incompleto: incompleta }),
    });
    // El periodo se marca aquí y no en el llamante para que valga igual desde el
    // trabajo automático, el botón manual y el script: si no, el automático
    // repetiría el periodo que acaba de generar una persona.
    //
    // Y solo se marca si **no ha quedado nada fuera**: ver `motivoIncompleto`.
    if (!incompleta) {
      try {
        await marcarPeriodoGenerado(dominio.claves, objetivo, resumen);
      } catch (err) {
        // El periodo está facturado: no volver a facturarlo lo garantiza la marca
        // de cada elemento, no este apunte.
        console.warn(
          `[${dominio.etiqueta}] No se pudo marcar el periodo como generado:`,
          err?.message || err
        );
      }
    } else {
      console.error(
        `[${dominio.etiqueta}] Periodo ${objetivo} incompleto (${incompleta}):` +
          ` ${creadas.length} documento(s) escritos, ${errores.length} error(es),` +
          ` ${descartados.length} descartado(s). El periodo NO se marca como generado:` +
          ' la tanda siguiente lo reintentará y recogerá solo lo que quedó fuera.'
      );
    }

    return dominio.describirGeneracion({
      periodo: objetivo,
      ajustes,
      contexto,
      plan,
      ejecucion,
      origen,
      creadas,
      descartados,
      excluidos,
      cerrados,
      liberados,
      errores,
      resumen,
      interrumpida,
      parcial: !!incompleta,
      motivo_incompleto: incompleta || '',
    });
  } finally {
    clearInterval(latido);
    await dominio.cerrojo.liberar(ejecucion);
  }
}
