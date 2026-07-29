import express from 'express';
import { ScanCommand, QueryCommand, PutCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { hasPermission } from '../middleware/auth.js';
import { formatId6 } from '../lib/usuarioLocales.js';
import { resolveTotalAportacionUnitaria } from '../lib/pedidos/rappelAcuerdo.js';
import { idsAlmacenGeneral } from '../lib/pedidos/almacenGeneral.js';

const router = express.Router();

const ESTADO_BORRADOR = 'Borrador';
const MAX_REINTENTOS_ID = 25;

/**
 * Contrato de la facturación mensual del almacén.
 *
 * Los campos los escribe el generador de facturas; aquí solo se leen para
 * congelar el pedido, porque una factura ya emitida fija dos cosas del pedido:
 * el **importe** (la suma de sus líneas) y el **periodo** (`CompletadoEn`, la
 * fecha que decide a qué mes pertenece). Mientras no exista ninguna de estas
 * marcas, el pedido se comporta exactamente como siempre.
 *
 *   factura_ventas_id + factura_ventas_periodo → venta de la mercancía al local
 *   factura_rappel_id + factura_rappel_periodo → rappel/aportación del periodo
 *   factura_id_empresa_local                   → sociedad del local (`LocalId`)
 *                                                congelada al completar
 *
 * El identificador de la factura es un UUID, que no le dice nada a quien está
 * preparando pedidos, así que el mensaje de rechazo se construye con el
 * **periodo**: es lo que permite encontrar el documento en la pantalla de
 * facturación. El número de factura sería mejor, pero los documentos generados
 * nacen en borrador y sin numerar (se reserva al emitirlos), así que hoy nadie lo
 * escribe en el pedido; se lee por si algún día se hace, y el UUID queda como
 * último recurso.
 */
const MARCAS_FACTURACION = [
  {
    id: 'factura_ventas_id',
    numero: 'factura_ventas_numero',
    periodo: 'factura_ventas_periodo',
    etiqueta: 'la factura de venta de mercancía',
  },
  {
    id: 'factura_rappel_id',
    numero: 'factura_rappel_numero',
    periodo: 'factura_rappel_periodo',
    etiqueta: 'el abono de rappel',
  },
];

/**
 * Testigo de que el pedido sigue sin facturar **en el momento de escribir**.
 *
 * Todas las guardas de este router leen la cabecera, deciden y escriben después:
 * entre las dos cosas cabe el trabajo programado que factura el mes, que empieza
 * a las 06:00 del día 1, plena hora de cierre en hostelería. Con esta condición
 * en la escritura, el que llega tarde no pisa la marca ni cambia el importe: se
 * le devuelve un 409 y se queda sin efecto.
 */
const CONDICION_SIN_FACTURAR = MARCAS_FACTURACION
  .map((m) => `attribute_not_exists(${m.id})`)
  .join(' AND ');

/**
 * Cabecera mínima que necesitan las guardas y el cálculo de líneas. El periodo de
 * cada marca entra porque es con lo que se nombra el documento que bloquea.
 *
 * Los otros campos que escribe el generador (fecha del marcado, ejecución y
 * sociedad emisora) no hace falta ni leerlos: ninguna escritura de este router
 * reconstruye el ítem entero, así que nadie los pisa.
 */
const PROYECCION_CABECERA = [
  'Id',
  'Estado',
  'Fecha',
  'LocalId',
  'CompletadoEn',
  'factura_id_empresa_local',
  ...MARCAS_FACTURACION.flatMap((m) => [m.id, m.numero, m.periodo]),
].join(', ');

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** '2026-06' → 'junio de 2026'; '' si no es un periodo mensual reconocible. */
function mesLargo(periodo) {
  const m = String(periodo ?? '').trim().match(/^(\d{4})-(\d{2})$/);
  const mes = m ? MESES[parseInt(m[2], 10) - 1] : null;
  return mes ? `${mes} de ${m[1]}` : '';
}

/**
 * Cómo nombrar los documentos que ya han facturado el pedido; [] si no hay
 * ninguno. Cada uno se nombra con lo mejor que haya: su número si algún día
 * existe, su periodo (lo normal) y el UUID como último recurso.
 *
 * Cuenta la **presencia** del campo, no su valor, porque es lo que mira la
 * condición de las escrituras (`attribute_not_exists`): si la guarda diera por
 * bueno un id vacío, el pedido se quedaría rechazando cada intento con un
 * mensaje genérico que invita a reintentar para siempre.
 */
function referenciasFacturacion(pedido) {
  const refs = [];
  for (const marca of MARCAS_FACTURACION) {
    if (pedido?.[marca.id] === undefined) continue;
    const numero = String(pedido[marca.numero] ?? '').trim();
    const periodo = mesLargo(pedido[marca.periodo]);
    const id = String(pedido[marca.id] ?? '').trim();
    if (numero) refs.push(`${marca.etiqueta} ${numero}`);
    else if (periodo) refs.push(`${marca.etiqueta} de ${periodo}`);
    else if (id) refs.push(`${marca.etiqueta} ${id}`);
    else refs.push(marca.etiqueta);
  }
  return refs;
}

/** ¿El pedido está facturado? Único criterio que congela importe y periodo. */
function pedidoFacturado(pedido) {
  return referenciasFacturacion(pedido).length > 0;
}

/**
 * Mensaje de rechazo de una operación sobre un pedido facturado, o '' si el
 * pedido no lo está: sin marca de facturación ninguna guarda se dispara.
 */
function errorPedidoFacturado(pedido, accion = 'cambiarlo') {
  const refs = referenciasFacturacion(pedido);
  if (refs.length === 0) return '';
  const documento = refs.length > 1 ? 'esos documentos' : 'ese documento';
  return `Este pedido ya está facturado en ${refs.join(' y ')}; para ${accion} hay que rectificar ${documento}.`;
}

const ERROR_ORIGEN_ENTRE_LOCALES = 'No tienes permiso para enviar mercancía desde el almacén de otro local: ese pedido genera factura entre sociedades.';

/**
 * Mensaje de rechazo cuando la mercancía sale del almacén de un local en vez del
 * Almacén General, o '' si la operación es legítima.
 *
 * Ese pedido acaba en una factura entre las dos sociedades del grupo, así que
 * exige `pedidos.crear_entre_locales`. El frontend ya oculta la opción, pero sin
 * esta comprobación bastaba con llamar al endpoint.
 *
 * La devolución al Almacén General (local → general) es operativa normal de
 * cualquier usuario y sale legítimamente del almacén de un local: queda exenta.
 * Para que declarar `Tipo: 'Devolucion'` no sea la puerta de atrás, la exención
 * pide que el destino sea el general; una "devolución" de un local a otro vuelve
 * a ser una venta interna y pasa por el permiso.
 *
 * Si el maestro leído no tiene ningún Almacén General, ningún origen se da por
 * general y el permiso se exige, que es el lado seguro. Pero si el maestro **no
 * se ha podido leer** no se exige nada: preparar y crear pedidos es la operativa
 * diaria del almacén y una avería de DynamoDB no puede pararla. Lo que se cuela
 * en ese hueco es un pedido interlocal de más, que acaba en una factura en
 * borrador que alguien revisa antes de emitirla.
 */
async function errorPermisoOrigenEntreLocales(req, { tipo, almacenOrigenId, almacenDestinoId }) {
  const origenId = String(almacenOrigenId ?? '').trim();
  if (!origenId) return '';
  const maestro = await idsAlmacenGeneral();
  if (!maestro.ok) return '';
  const generales = maestro.ids;
  if (generales.has(origenId)) return '';
  if (String(tipo ?? '').trim() === 'Devolucion' && generales.has(String(almacenDestinoId ?? '').trim())) return '';
  if (await hasPermission(req.user, 'pedidos.crear_entre_locales')) return '';
  return ERROR_ORIGEN_ENTRE_LOCALES;
}

/**
 * Por qué falló una escritura condicionada a que el pedido no esté facturado.
 *
 * La condición no dice cuál de sus partes falló, así que se relee la cabecera:
 * hace falta de todas formas para nombrar la factura, que es lo único que le
 * dice al usuario qué tiene que hacer a continuación.
 *
 * @returns {Promise<{ status: number, error: string }>}
 */
async function motivoConflictoPedido(id, accion) {
  let cabecera = null;
  try {
    cabecera = await getCabeceraPedido(id);
  } catch (err) {
    console.error('[pedidos] No se pudo releer la cabecera tras el conflicto', id, err.message || err);
    return { status: 409, error: 'El pedido ha cambiado mientras se guardaba; recárgalo e inténtalo de nuevo.' };
  }
  if (!cabecera) return { status: 404, error: 'Pedido no encontrado' };
  const bloqueoFacturado = errorPedidoFacturado(cabecera, accion);
  if (bloqueoFacturado) return { status: 409, error: bloqueoFacturado };
  return { status: 409, error: 'El pedido ha cambiado mientras se guardaba; recárgalo e inténtalo de nuevo.' };
}

/**
 * Reclama la edición de las líneas del pedido: sube el contador de revisión y,
 * en la misma escritura condicional, comprueba que el pedido no se ha facturado.
 *
 * El contador es el testigo con el que el generador de facturas detecta que las
 * líneas que va a facturar ya no son las que leyó: la cabecera no tiene ningún
 * otro campo que se mueva al editar una línea (el PUT de línea reescribe la
 * línea y no toca el pedido).
 *
 * Subirlo **antes** de escribir la línea hace dos cosas: invalida al generador
 * que ya había leído esta cabecera, y es el reclamo que comprueba que el pedido
 * no está facturado mientras nadie ha tocado todavía el importe. Si el reclamo
 * pasa pero la línea falla, queda un contador de más, que solo hace que el
 * generador vuelva a leer. No basta con esto: ver `confirmarEdicionLineas`.
 *
 * Los pedidos anteriores al contador no tienen el atributo: su estado inicial
 * válido es la ausencia, y `ADD` lo crea desde 0 en la primera escritura.
 *
 * Sin cabecera no hay nada que versionar ni factura que proteger, y la línea se
 * escribe como se escribía: la condición está para que un `Update` no invente un
 * pedido fantasma con solo `Id` y contador a partir de una línea huérfana.
 *
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
async function reservarEdicionLineas(pedidoId, accion) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: tables.pedidos,
      Key: { Id: pedidoId },
      UpdateExpression: 'ADD lineas_rev :uno',
      ConditionExpression: `attribute_exists(Id) AND ${CONDICION_SIN_FACTURAR}`,
      ExpressionAttributeValues: { ':uno': 1 },
    }));
    return { ok: true };
  } catch (err) {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
    const conflicto = await motivoConflictoPedido(pedidoId, accion);
    if (conflicto.status === 404) return { ok: true };
    return { ok: false, ...conflicto };
  }
}

/**
 * Vuelve a subir el contador **después** de escribir la línea, que es la mitad
 * que faltaba de la invariante: el contador tiene que moverse después de la
 * última escritura de contenido.
 *
 * Con solo el reclamo previo quedaba un hueco de un viaje de ida y vuelta en el
 * que el generador podía leer la cabecera ya con el contador nuevo y las líneas
 * todavía con el contenido viejo; su reclamo cuadraba y la factura salía con el
 * importe antiguo. Reclamando antes y sellando después, cualquier lectura de la
 * pareja (cabecera, líneas) que sea incoherente ve el contador cambiar detrás.
 *
 * No va condicionada a la ausencia de marca a propósito: si el pedido acabó de
 * reclamarlo un flujo (la venta) mientras se escribía, la marca del otro (el
 * rappel) sigue libre, y ese contador tiene que moverse igualmente para que el
 * segundo no facture un importe que ya cambió. Un fallo aquí no puede tumbar la
 * operación —la línea ya está escrita— pero sí se registra: deja al generador
 * con un testigo desactualizado.
 */
async function confirmarEdicionLineas(pedidoId) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: tables.pedidos,
      Key: { Id: pedidoId },
      UpdateExpression: 'ADD lineas_rev :uno',
      ConditionExpression: 'attribute_exists(Id)',
      ExpressionAttributeValues: { ':uno': 1 },
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return;
    console.error('[pedidos] No se pudo sellar el contador de líneas de', pedidoId, err.message || err);
  }
}

/**
 * Sociedad de un local (`igp_Locales.id_empresa`) para congelarla en el pedido al
 * completarlo: entre que se sirve la mercancía y se factura el mes, un local
 * puede cambiar de sociedad y la factura saldría a nombre de la equivocada.
 *
 * Devuelve '' si no hay local o si no se pudo resolver. Congelar mejora la
 * factura, pero no es requisito de la preparación: nunca debe impedir que el
 * almacén cierre un pedido, y si falta, la facturación resuelve la sociedad
 * contra el maestro.
 */
async function resolverSociedadLocal(localIdBruto) {
  const localId = String(localIdBruto ?? '').trim();
  if (!localId) return '';
  try {
    const r = await docClient.send(new GetCommand({
      TableName: tables.locales,
      Key: { id_Locales: localId },
      ProjectionExpression: 'id_empresa',
    }));
    const idEmpresa = formatId6(r.Item?.id_empresa);
    return idEmpresa === '000000' ? '' : idEmpresa;
  } catch (err) {
    console.error('[pedidos] No se pudo congelar la sociedad del local', localId, err.message || err);
    return '';
  }
}

/** Año (4 cifras) desde Fecha en ISO (YYYY-MM-DD) o dd/mm/aaaa; null si no se reconoce. */
function añoDesdeFecha(fecha) {
  const t = String(fecha ?? '').trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return parseInt(t.slice(0, 4), 10);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return parseInt(m[3], 10);
  const m2 = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m2) {
    let y = parseInt(m2[3], 10);
    if (y < 100) y += 2000;
    return y;
  }
  return null;
}

function buildPedidoId(año, n) {
  return `PED-${año}-${String(n).padStart(5, '0')}`;
}

/** Normaliza una fecha de pedido (ISO o dd/mm/aaaa) a 'YYYY-MM-DD'; '' si no se reconoce. */
function fechaPedidoToIso(fecha) {
  const s = String(fecha ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m2) return `20${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  return '';
}

/** Fecha de referencia para el informe de ventas: CompletadoEn (OK almacén) o Fecha pedido (legacy). */
function fechaReferenciaVentas(pedido) {
  const completadoEn = String(pedido?.CompletadoEn ?? '').trim();
  if (completadoEn) {
    const iso = fechaPedidoToIso(completadoEn.slice(0, 10));
    if (iso) return iso;
  }
  return fechaPedidoToIso(pedido?.Fecha) || String(pedido?.Fecha ?? '').trim().slice(0, 10);
}

/** Mayor secuencial usado para PED-AAAA-NNNNN en un año (0 si no hay ninguno). */
async function maxSecuencialPedidoAño(año) {
  const re = new RegExp(`^PED-${año}-(\\d+)$`, 'i');
  let max = 0;
  let lastKey = null;
  do {
    const result = await docClient.send(new ScanCommand({
      TableName: tables.pedidos,
      ProjectionExpression: 'Id',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    for (const it of result.Items || []) {
      const m = String(it.Id ?? '').match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!Number.isNaN(n)) max = Math.max(max, n);
      }
    }
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return max;
}

/** Porcentaje de beneficio global (ajustes → personalización). 0 si no está configurado. */
async function getPorcentajeBeneficio() {
  try {
    const r = await docClient.send(new GetCommand({
      TableName: tables.ajustes,
      Key: { PK: 'personalizacion', SK: 'app' },
    }));
    const p = r.Item?.PorcentajeBeneficio;
    const n = typeof p === 'number' ? p : parseFloat(String(p ?? ''));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Estado actual de un pedido; null si no existe. */
async function getEstadoPedido(id) {
  const got = await docClient.send(new GetCommand({
    TableName: tables.pedidos,
    Key: { Id: id },
    ProjectionExpression: 'Estado',
  }));
  return got.Item ? String(got.Item.Estado ?? '') : null;
}

/** Cabecera del pedido para las guardas (estado + marca de facturación); null si no existe. */
async function getCabeceraPedido(id) {
  const got = await docClient.send(new GetCommand({
    TableName: tables.pedidos,
    Key: { Id: id },
    ProjectionExpression: PROYECCION_CABECERA,
  }));
  return got.Item || null;
}

/**
 * Recalcula el estado de un pedido en función de cuántas líneas están preparadas,
 * para reflejar el avance del almacén sin intervención manual:
 *   - 0 preparadas        → 'Enviado'    (esperando preparación)
 *   - parcialmente        → 'Pendiente'  (en preparación)
 *   - todas preparadas    → 'Completado' (listo)
 * No toca pedidos en 'Borrador' (el bar aún lo está montando) ni los exportados.
 * Tampoco los facturados: `CompletadoEn` es la fecha que decide en qué mes se
 * facturó el pedido, y aquí se hacía REMOVE de ella al desmarcar una línea
 * preparada, con lo que al volver a completarlo el pedido cambiaba de periodo y
 * descuadraba una factura ya emitida.
 * Es tolerante a fallos: cualquier error se registra y no rompe la operación de línea.
 */
async function recomputarEstadoPorPreparacion(pedidoId, usuarioEmail = '') {
  try {
    const cabecera = await getCabeceraPedido(pedidoId);
    const estadoActual = cabecera ? String(cabecera.Estado ?? '') : '';
    if (!estadoActual) return;
    if (estadoActual === ESTADO_BORRADOR || estadoActual === 'Exportado') return;
    // Los endpoints de línea ya rechazan tocar un pedido facturado; esta segunda
    // comprobación protege la fecha de completado de cualquier otra llamada.
    if (pedidoFacturado(cabecera)) return;

    const q = await docClient.send(new QueryCommand({
      TableName: tables.pedidosLineas,
      KeyConditionExpression: 'PedidoId = :pid',
      ExpressionAttributeValues: { ':pid': pedidoId },
      ProjectionExpression: 'Preparada',
    }));
    const lineas = q.Items || [];
    const total = lineas.length;
    if (total === 0) return;
    const preparadas = lineas.filter((l) => !!l.Preparada).length;

    let nuevoEstado;
    if (preparadas === 0) nuevoEstado = 'Enviado';
    else if (preparadas === total) nuevoEstado = 'Completado';
    else nuevoEstado = 'Pendiente';

    if (nuevoEstado === estadoActual) return;

    // La condición repite la comprobación de arriba en el momento de escribir: la
    // cabecera se leyó antes y el pedido puede haberse facturado desde entonces.
    const sinFacturar = `attribute_exists(Id) AND ${CONDICION_SIN_FACTURAR}`;
    if (nuevoEstado === 'Completado') {
      // Al completar se sabe quién recibió la mercancía: es el momento de fijar la
      // sociedad del local para que la factura del mes no dependa de que el
      // maestro de locales siga igual semanas después.
      const yaCongelada = String(cabecera.factura_id_empresa_local ?? '').trim();
      const idEmpresaLocal = yaCongelada ? '' : await resolverSociedadLocal(cabecera.LocalId);
      await docClient.send(new UpdateCommand({
        TableName: tables.pedidos,
        Key: { Id: pedidoId },
        UpdateExpression: 'SET Estado = :e, CompletadoEn = :c, CompletadoPor = :p'
          + (idEmpresaLocal ? ', factura_id_empresa_local = :emp' : ''),
        ConditionExpression: sinFacturar,
        ExpressionAttributeValues: {
          ':e': nuevoEstado,
          ':c': new Date().toISOString(),
          ':p': String(usuarioEmail ?? '').trim(),
          ...(idEmpresaLocal && { ':emp': idEmpresaLocal }),
        },
      }));
    } else {
      await docClient.send(new UpdateCommand({
        TableName: tables.pedidos,
        Key: { Id: pedidoId },
        UpdateExpression: 'SET Estado = :e REMOVE CompletadoEn, CompletadoPor',
        ConditionExpression: sinFacturar,
        ExpressionAttributeValues: { ':e': nuevoEstado },
      }));
    }
  } catch (err) {
    // Que la condición falle no es una avería: significa que el pedido se facturó
    // mientras se recalculaba y su estado y su fecha ya no son nuestros.
    if (err?.name === 'ConditionalCheckFailedException') return;
    console.error('[recomputarEstadoPorPreparacion]', err.message || err);
  }
}

// GET /pedidos
router.get('/pedidos', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const result = await docClient.send(new ScanCommand({
        TableName: tables.pedidos,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);

    // Calcular TotalAlbaran como suma de TotalLinea del detalle de cada pedido
    const lineasItems = [];
    let lineasLastKey = null;
    do {
      const lineasResult = await docClient.send(new ScanCommand({
        TableName: tables.pedidosLineas,
        ...(lineasLastKey && { ExclusiveStartKey: lineasLastKey }),
      }));
      lineasItems.push(...(lineasResult.Items || []));
      lineasLastKey = lineasResult.LastEvaluatedKey || null;
    } while (lineasLastKey);

    const totalesPorPedido = {};
    const conteoLineasPorPedido = {};
    for (const linea of lineasItems) {
      const pid = String(linea.PedidoId ?? '');
      if (!pid) continue;
      const totalLinea = Number(linea.TotalLinea ?? 0);
      totalesPorPedido[pid] = (totalesPorPedido[pid] ?? 0) + totalLinea;
      const c = conteoLineasPorPedido[pid] ?? { total: 0, preparadas: 0 };
      c.total += 1;
      if (linea.Preparada) c.preparadas += 1;
      conteoLineasPorPedido[pid] = c;
    }

    for (const p of items) {
      const pid = String(p.Id ?? '');
      p.TotalAlbaran = totalesPorPedido[pid] ?? 0;
      const c = conteoLineasPorPedido[pid] ?? { total: 0, preparadas: 0 };
      p.LineasTotal = c.total;
      p.LineasPreparadas = c.preparadas;
    }

    items.sort((a, b) => String(b.Fecha ?? b.Id ?? '').localeCompare(String(a.Fecha ?? a.Id ?? '')));
    res.json({ pedidos: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar pedidos' });
  }
});

/** Normaliza un nombre de empresa para comparar (trim + minúsculas, sin dobles espacios). */
function normalizarEmpresa(val) {
  return String(val ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// GET /pedidos/abonos?empresa=<nombre>&local=<id>&anio=2026&mes=06&modo=abonos|ventas
// Informe calculado por empresa y periodo. `local` y `mes` son opcionales.
//  - modo=abonos (defecto): suma de rappels (lo que el almacén debe abonar al local).
//    Incluye solo líneas con TotalRappel > 0, sin filtrar por estado del pedido.
//  - modo=ventas: suma de TotalLinea con margen (lo que se cobra a la sociedad).
//    Incluye solo pedidos 'Completado' y líneas con TotalLinea > 0.
//    El periodo se filtra por CompletadoEn (fecha OK almacén); sin ese campo, usa Fecha del pedido.
// En ambos modos cada línea devuelve un campo genérico `Importe` con la métrica del modo.
router.get('/pedidos/abonos', async (req, res) => {
  const empresa = String(req.query.empresa ?? '').trim();
  const local = String(req.query.local ?? '').trim();
  const anio = String(req.query.anio ?? '').trim();
  const mes = String(req.query.mes ?? '').trim();
  const modo = String(req.query.modo ?? 'abonos').trim() === 'ventas' ? 'ventas' : 'abonos';
  if (!empresa) return res.status(400).json({ error: 'empresa obligatoria' });
  if (!/^\d{4}$/.test(anio)) return res.status(400).json({ error: 'anio inválido (AAAA)' });
  const prefijo = mes ? `${anio}-${mes.padStart(2, '0')}` : anio;
  try {
    // 1) Locales de la empresa (enlace por nombre: igp_Locales.empresa === empresa.Nombre).
    const localesRaw = [];
    let lastLoc = null;
    do {
      const r = await docClient.send(new ScanCommand({
        TableName: tables.locales,
        ProjectionExpression: 'id_Locales, nombre, empresa',
        ...(lastLoc && { ExclusiveStartKey: lastLoc }),
      }));
      localesRaw.push(...(r.Items || []));
      lastLoc = r.LastEvaluatedKey || null;
    } while (lastLoc);

    const empresaNorm = normalizarEmpresa(empresa);
    const nombrePorLocalId = {};
    const localIdsEmpresa = new Set();
    for (const l of localesRaw) {
      if (normalizarEmpresa(l.empresa) !== empresaNorm) continue;
      const idLoc = String(l.id_Locales ?? '').trim();
      if (!idLoc) continue;
      nombrePorLocalId[idLoc] = String(l.nombre ?? idLoc).trim();
      if (!local || idLoc === local) localIdsEmpresa.add(idLoc);
    }

    if (localIdsEmpresa.size === 0) {
      return res.json({ ok: true, empresa, local: local || null, anio, mes: mes || null, modo, total: 0, items: [], pedidos: [] });
    }

    // 2) Pedidos de esos locales.
    const pedidos = [];
    let lastKey = null;
    do {
      const r = await docClient.send(new ScanCommand({
        TableName: tables.pedidos,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      pedidos.push(...(r.Items || []));
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);

    const pedidosPeriodo = pedidos.filter((p) => {
      const lid = String(p.LocalId ?? '').trim();
      if (!localIdsEmpresa.has(lid)) return false;
      // En ventas solo cuentan los pedidos ya completados (facturables).
      if (modo === 'ventas' && String(p.Estado ?? '').trim() !== 'Completado') return false;
      const fechaRef = modo === 'ventas' ? fechaReferenciaVentas(p) : fechaPedidoToIso(p.Fecha) || String(p.Fecha ?? '').trim();
      return fechaRef ? fechaRef.startsWith(prefijo) : false;
    });

    const items = [];
    const resumenPedidos = [];
    let total = 0;

    for (const p of pedidosPeriodo) {
      const pid = String(p.Id ?? '');
      if (!pid) continue;
      const localId = String(p.LocalId ?? '').trim();
      const localNombre = nombrePorLocalId[localId] || localId;
      const fechaPedido = String(p.Fecha ?? '').trim();
      const creadoEn = String(p.CreadoEn ?? '').trim();
      const completadoEn = String(p.CompletadoEn ?? '').trim();
      const esDevolucion = String(p.Tipo ?? 'Pedido').trim() === 'Devolucion';
      // Una devolución resta en ambos informes: en ventas anula el importe a cobrar
      // y en abonos anula el rappel que generó la compra original (neto = 0).
      const signo = esDevolucion ? -1 : 1;
      const q = await docClient.send(new QueryCommand({
        TableName: tables.pedidosLineas,
        KeyConditionExpression: 'PedidoId = :pid',
        ExpressionAttributeValues: { ':pid': pid },
      }));
      let totalPedido = 0;
      for (const l of q.Items || []) {
        const base = modo === 'ventas' ? Number(l.TotalLinea ?? 0) : Number(l.TotalRappel ?? 0);
        if (!(base > 0)) continue;
        const importe = signo * base;
        items.push({
          PedidoId: pid,
          LineaIndex: l.LineaIndex ?? null,
          LocalId: localId,
          LocalNombre: localNombre,
          Fecha: fechaPedido,
          CreadoEn: creadoEn,
          ...(completadoEn ? { CompletadoEn: completadoEn } : {}),
          Tipo: esDevolucion ? 'Devolucion' : 'Pedido',
          ProductId: String(l.ProductId ?? ''),
          ProductoNombre: String(l.ProductoNombre ?? ''),
          Cantidad: signo * Number(l.Cantidad ?? 0),
          VatRate: l.VatRate != null ? Number(l.VatRate) : null,
          Importe: importe,
        });
        totalPedido += importe;
      }
      if (totalPedido !== 0) {
        resumenPedidos.push({
          Id: pid,
          LocalId: localId,
          LocalNombre: localNombre,
          Fecha: fechaPedido,
          ...(completadoEn ? { CompletadoEn: completadoEn } : {}),
          Tipo: esDevolucion ? 'Devolucion' : 'Pedido',
          Importe: totalPedido,
        });
        total += totalPedido;
      }
    }

    const fechaOrden = (row) => (modo === 'ventas' ? String(row.CompletadoEn || row.Fecha) : String(row.Fecha));
    items.sort((a, b) => {
      const fc = fechaOrden(a).localeCompare(fechaOrden(b));
      if (fc !== 0) return fc;
      const lc = String(a.LocalNombre).localeCompare(String(b.LocalNombre), 'es', { sensitivity: 'base' });
      if (lc !== 0) return lc;
      const pc = String(a.PedidoId).localeCompare(String(b.PedidoId));
      if (pc !== 0) return pc;
      return Number(a.LineaIndex ?? 0) - Number(b.LineaIndex ?? 0);
    });
    resumenPedidos.sort((a, b) => fechaOrden(a).localeCompare(fechaOrden(b)));

    res.json({ ok: true, empresa, local: local || null, anio, mes: mes || null, modo, total, items, pedidos: resumenPedidos });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al calcular el informe' });
  }
});

// GET /pedidos/traspaso-export?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&incluirExportados=false
// Relación de artículos de pedidos COMPLETADOS en un rango de fechas, lista para
// generar el Excel de traspasos de Agora (una fila por línea de pedido).
router.get('/pedidos/traspaso-export', async (req, res) => {
  if (!(await hasPermission(req.user, 'pedidos.exportar_traspaso'))) {
    return res.status(403).json({ error: 'No tienes permiso para exportar traspasos' });
  }
  const desde = String(req.query.desde ?? '').trim();
  const hasta = String(req.query.hasta ?? '').trim();
  const incluirExportados = String(req.query.incluirExportados ?? '') === 'true';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    return res.status(400).json({ error: 'desde y hasta son obligatorios (YYYY-MM-DD)' });
  }
  if (desde > hasta) {
    return res.status(400).json({ error: 'El rango de fechas es inválido (desde > hasta)' });
  }
  try {
    // 1) Pedidos completados del rango.
    const pedidos = [];
    let lastKey = null;
    do {
      const r = await docClient.send(new ScanCommand({
        TableName: tables.pedidos,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      pedidos.push(...(r.Items || []));
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);

    const completadosRango = pedidos.filter((p) => {
      if (String(p.Estado ?? '').trim() !== 'Completado') return false;
      const iso = fechaPedidoToIso(p.Fecha);
      if (!iso || iso < desde || iso > hasta) return false;
      if (!incluirExportados && p.TraspasoExportadoEn) return false;
      return true;
    });

    // 2) Líneas de cada pedido → filas + resumen agregado por producto.
    const filas = [];
    const resumenMap = {};
    const pedidosResumen = [];
    let omitidas = 0;

    for (const p of completadosRango) {
      const pedidoId = String(p.Id ?? '');
      if (!pedidoId) continue;
      const fechaIso = fechaPedidoToIso(p.Fecha);
      const almacenOrigenId = String(p.AlmacenOrigenId ?? '').trim();
      const almacenDestinoId = String(p.AlmacenDestinoId ?? '').trim();

      const q = await docClient.send(new QueryCommand({
        TableName: tables.pedidosLineas,
        KeyConditionExpression: 'PedidoId = :pid',
        ExpressionAttributeValues: { ':pid': pedidoId },
      }));
      const lineas = q.Items || [];
      let lineasValidas = 0;
      for (const l of lineas) {
        const productId = String(l.ProductId ?? '').trim();
        const cantidad = Number(l.Cantidad ?? 0);
        if (!productId || !(cantidad > 0)) { omitidas += 1; continue; }
        filas.push({
          pedidoId,
          fechaIso,
          almacenOrigenId,
          almacenDestinoId,
          productId,
          productoNombre: String(l.ProductoNombre ?? '').trim(),
          cantidad,
        });
        lineasValidas += 1;
        const rk = resumenMap[productId] || { productId, productoNombre: String(l.ProductoNombre ?? '').trim(), cantidad: 0 };
        rk.cantidad += cantidad;
        if (!rk.productoNombre && l.ProductoNombre) rk.productoNombre = String(l.ProductoNombre).trim();
        resumenMap[productId] = rk;
      }
      pedidosResumen.push({
        Id: pedidoId,
        Fecha: String(p.Fecha ?? ''),
        FechaIso: fechaIso,
        LocalId: String(p.LocalId ?? '').trim(),
        AlmacenOrigenId: almacenOrigenId,
        AlmacenDestinoId: almacenDestinoId,
        lineasValidas,
        sinAlmacenes: !almacenOrigenId || !almacenDestinoId,
        TraspasoExportadoEn: p.TraspasoExportadoEn ?? null,
        TraspasoExportadoPor: p.TraspasoExportadoPor ?? null,
      });
    }

    const resumen = Object.values(resumenMap).sort((a, b) =>
      String(a.productoNombre || a.productId).localeCompare(String(b.productoNombre || b.productId), 'es', { sensitivity: 'base' }),
    );
    pedidosResumen.sort((a, b) => String(a.FechaIso).localeCompare(String(b.FechaIso)) || String(a.Id).localeCompare(String(b.Id)));

    res.json({
      ok: true,
      desde,
      hasta,
      incluirExportados,
      pedidos: pedidosResumen,
      filas,
      resumen,
      omitidas,
      totalUnidades: filas.reduce((s, f) => s + f.cantidad, 0),
    });
  } catch (err) {
    console.error('[pedidos/traspaso-export]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al preparar la exportación de traspasos' });
  }
});

// POST /pedidos/traspaso-export/marcar  body: { pedidoIds: [] }
// Marca los pedidos como ya exportados (control de duplicados). Idempotente.
router.post('/pedidos/traspaso-export/marcar', async (req, res) => {
  if (!(await hasPermission(req.user, 'pedidos.exportar_traspaso'))) {
    return res.status(403).json({ error: 'No tienes permiso para exportar traspasos' });
  }
  const ids = Array.isArray(req.body?.pedidoIds) ? req.body.pedidoIds.map((x) => String(x).trim()).filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'pedidoIds es obligatorio' });
  const now = new Date().toISOString();
  const email = String(req.user?.email ?? '').trim();
  let marcados = 0;
  for (const id of ids) {
    try {
      await docClient.send(new UpdateCommand({
        TableName: tables.pedidos,
        Key: { Id: id },
        UpdateExpression: 'SET TraspasoExportadoEn = :t, TraspasoExportadoPor = :p',
        ExpressionAttributeValues: { ':t': now, ':p': email },
        ConditionExpression: 'attribute_exists(Id)',
      }));
      marcados += 1;
    } catch (e) {
      if (e?.name !== 'ConditionalCheckFailedException') {
        console.error('[pedidos/traspaso-export/marcar]', id, e.message || e);
      }
    }
  }
  res.json({ ok: true, marcados, exportadoEn: now });
});

// POST /pedidos — el Id se genera SIEMPRE en el servidor (correlativo atómico por año).
// Se ignora cualquier Id que envíe el cliente para evitar colisiones entre tablets.
router.post('/pedidos', async (req, res) => {
  const body = req.body || {};
  try {
    const ahora = new Date().toISOString();
    const fecha = String(body.Fecha ?? '').trim();
    const año = añoDesdeFecha(fecha) ?? new Date().getFullYear();
    const baseItem = {
      LocalId: String(body.LocalId ?? '').trim(),
      AlmacenOrigenId: String(body.AlmacenOrigenId ?? '').trim(),
      AlmacenDestinoId: String(body.AlmacenDestinoId ?? '').trim(),
      TotalAlbaran: typeof body.TotalAlbaran === 'number' ? body.TotalAlbaran : parseFloat(String(body.TotalAlbaran ?? 0)) || 0,
      Fecha: fecha,
      Estado: String(body.Estado ?? ESTADO_BORRADOR).trim() || ESTADO_BORRADOR,
      // Tipo de movimiento: 'Pedido' (general → local) o 'Devolucion' (local → general).
      Tipo: String(body.Tipo ?? 'Pedido').trim() === 'Devolucion' ? 'Devolucion' : 'Pedido',
      CreadoEn: body.CreadoEn ?? ahora,
      CreadoPor: String(body.CreadoPor ?? req.user?.email ?? '').trim(),
      Notas: String(body.Notas ?? '').trim(),
    };

    const bloqueoOrigen = await errorPermisoOrigenEntreLocales(req, {
      tipo: baseItem.Tipo,
      almacenOrigenId: baseItem.AlmacenOrigenId,
      almacenDestinoId: baseItem.AlmacenDestinoId,
    });
    if (bloqueoOrigen) return res.status(403).json({ error: bloqueoOrigen });

    // Correlativo + escritura condicional con reintentos: si dos peticiones
    // calculan el mismo número, solo una gana y la otra reintenta con el siguiente.
    let n = (await maxSecuencialPedidoAño(año)) + 1;
    for (let intento = 0; intento < MAX_REINTENTOS_ID; intento++) {
      const id = buildPedidoId(año, n);
      const item = { Id: id, ...baseItem };
      try {
        await docClient.send(new PutCommand({
          TableName: tables.pedidos,
          Item: item,
          ConditionExpression: 'attribute_not_exists(Id)',
        }));
        return res.json({ ok: true, pedido: item });
      } catch (err) {
        if (err?.name === 'ConditionalCheckFailedException') {
          n += 1;
          continue;
        }
        throw err;
      }
    }
    return res.status(409).json({ error: 'No se pudo asignar un Id único para el pedido, inténtalo de nuevo' });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al crear pedido' });
  }
});

/**
 * Compone un `UpdateExpression` poniendo alias a todos los nombres de atributo,
 * para que ningún campo del pedido pueda chocar con una palabra reservada de
 * DynamoDB. Un campo con valor `undefined` no se escribe, y lo que se fija no se
 * borra a la vez (DynamoDB rechaza el solape de rutas).
 */
function construirUpdate(fijar, borrar = []) {
  const ExpressionAttributeNames = {};
  const ExpressionAttributeValues = {};
  const sets = [];
  const removes = [];
  let n = 0;
  for (const [campo, valor] of Object.entries(fijar)) {
    if (valor === undefined) continue;
    ExpressionAttributeNames[`#c${n}`] = campo;
    ExpressionAttributeValues[`:v${n}`] = valor;
    sets.push(`#c${n} = :v${n}`);
    n += 1;
  }
  for (const campo of new Set(borrar)) {
    if (fijar[campo] !== undefined) continue;
    ExpressionAttributeNames[`#c${n}`] = campo;
    removes.push(`#c${n}`);
    n += 1;
  }
  return {
    UpdateExpression: [
      sets.length ? `SET ${sets.join(', ')}` : '',
      removes.length ? `REMOVE ${removes.join(', ')}` : '',
    ].filter(Boolean).join(' '),
    ExpressionAttributeNames,
    ExpressionAttributeValues,
  };
}

// PUT /pedidos
// Escribe **solo** los campos que edita. Antes reconstruía el ítem entero y lo
// guardaba con un `Put`, así que pisaba en silencio cualquier atributo escrito
// por otro proceso entre la lectura y la escritura: la marca de facturación (y
// con ella un pedido facturado que volvía a parecer libre y facturable otra vez),
// el contador de revisión de las líneas, la fecha de completado que el almacén
// acababa de fijar o la marca de traspaso exportado.
router.put('/pedidos', async (req, res) => {
  const body = req.body || {};
  const id = body.Id != null ? String(body.Id).trim() : '';
  if (!id) return res.status(400).json({ error: 'Id es obligatorio para editar' });
  try {
    const got = await docClient.send(new GetCommand({ TableName: tables.pedidos, Key: { Id: id } }));
    const existing = got.Item;
    if (!existing) return res.status(404).json({ error: 'Pedido no encontrado' });

    // Este endpoint puede cambiar el local (y con él la sociedad a la que se
    // factura), la fecha, el total y el estado: con el pedido ya facturado
    // cualquiera de esos cambios descuadra la factura. Se comprueba aquí para dar
    // el motivo cuanto antes y otra vez en la condición de la escritura, que es
    // lo que cierra la carrera.
    const bloqueoFacturado = errorPedidoFacturado(existing, 'cambiarlo');
    if (bloqueoFacturado) return res.status(409).json({ error: bloqueoFacturado });

    // Inmutabilidad: un pedido que ya salió de "Borrador" (lo envió el local)
    // solo puede modificarlo quien tenga el permiso de almacén central.
    const estadoExistente = String(existing.Estado ?? '');
    if (estadoExistente && estadoExistente !== ESTADO_BORRADOR) {
      if (!(await hasPermission(req.user, 'pedidos.editar_enviado'))) {
        return res.status(403).json({ error: 'No puedes modificar un pedido ya enviado' });
      }
    }
    const fijar = {
      LocalId: body.LocalId != null ? String(body.LocalId).trim() : String(existing.LocalId ?? ''),
      AlmacenOrigenId: body.AlmacenOrigenId != null ? String(body.AlmacenOrigenId).trim() : String(existing.AlmacenOrigenId ?? ''),
      AlmacenDestinoId: body.AlmacenDestinoId != null ? String(body.AlmacenDestinoId).trim() : String(existing.AlmacenDestinoId ?? ''),
      TotalAlbaran: body.TotalAlbaran != null ? (typeof body.TotalAlbaran === 'number' ? body.TotalAlbaran : parseFloat(String(body.TotalAlbaran)) || 0) : (existing.TotalAlbaran ?? 0),
      Fecha: body.Fecha != null ? String(body.Fecha).trim() : String(existing.Fecha ?? ''),
      Estado: body.Estado != null ? String(body.Estado).trim() : String(existing.Estado ?? ESTADO_BORRADOR),
      Notas: body.Notas != null ? String(body.Notas).trim() : String(existing.Notas ?? ''),
      // Tipo de movimiento: se preserva el existente; el cliente puede fijarlo si lo envía.
      Tipo: body.Tipo != null
        ? (String(body.Tipo).trim() === 'Devolucion' ? 'Devolucion' : 'Pedido')
        : (String(existing.Tipo ?? 'Pedido').trim() === 'Devolucion' ? 'Devolucion' : 'Pedido'),
    };
    const borrar = [];
    // Mover el origen a un almacén que no sea el general convierte el pedido en
    // una venta entre sociedades: mismo permiso que al crearlo. Solo se valida
    // cuando la petición cambia el origen, para no bloquear el resto de ediciones
    // de un pedido interlocal ya creado (prepararlo, completarlo, anotarlo).
    if (fijar.AlmacenOrigenId !== String(existing.AlmacenOrigenId ?? '').trim()) {
      const bloqueoOrigen = await errorPermisoOrigenEntreLocales(req, {
        tipo: fijar.Tipo,
        almacenOrigenId: fijar.AlmacenOrigenId,
        almacenDestinoId: fijar.AlmacenDestinoId,
      });
      if (bloqueoOrigen) return res.status(403).json({ error: bloqueoOrigen });
    }
    // Certificación de devolución: se sella la primera vez que el cliente lo
    // solicita. Deja constancia de quién y cuándo.
    if (body.certificarDevolucion === true && !existing.DevolucionCertificadaEn) {
      fijar.DevolucionCertificadaEn = new Date().toISOString();
      fijar.DevolucionCertificadaPor = String(req.user?.email ?? '').trim();
    }
    const nuevoEstado = fijar.Estado;
    if (nuevoEstado === 'Completado') {
      if (!existing.CompletadoEn) {
        fijar.CompletadoEn = new Date().toISOString();
        fijar.CompletadoPor = String(req.user?.email ?? '').trim();
      }
    } else {
      // Sacar el pedido de completado le quita la fecha, como hasta ahora.
      borrar.push('CompletadoEn', 'CompletadoPor');
    }
    // Cambiar de local cambia la sociedad que recibe la mercancía, así que la que
    // se congeló al completar deja de valer: se rehace para el local nuevo y, si
    // el pedido aún no está completado, se borra y volverá a congelarse cuando lo
    // esté. Conservarla sacaba la factura del mes a nombre de una sociedad
    // mientras el desglose imputaba la mercancía a un local de otra.
    const cambiaLocal = fijar.LocalId !== String(existing.LocalId ?? '').trim();
    const congelada = String(existing.factura_id_empresa_local ?? '').trim();
    if (nuevoEstado === 'Completado' && (cambiaLocal || !congelada)) {
      const idEmpresaLocal = await resolverSociedadLocal(fijar.LocalId);
      if (idEmpresaLocal) fijar.factura_id_empresa_local = idEmpresaLocal;
      else if (congelada) borrar.push('factura_id_empresa_local');
    } else if (cambiaLocal && congelada) {
      borrar.push('factura_id_empresa_local');
    }

    let pedido;
    try {
      const escrito = await docClient.send(new UpdateCommand({
        TableName: tables.pedidos,
        Key: { Id: id },
        ...construirUpdate(fijar, borrar),
        ConditionExpression: `attribute_exists(Id) AND ${CONDICION_SIN_FACTURAR}`,
        ReturnValues: 'ALL_NEW',
      }));
      pedido = escrito.Attributes;
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      const conflicto = await motivoConflictoPedido(id, 'cambiarlo');
      return res.status(conflicto.status).json({ error: conflicto.error });
    }
    res.json({ ok: true, pedido });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar pedido' });
  }
});

// DELETE /pedidos — borra también todas las líneas (evita huérfanas si se reutiliza el mismo Id)
//
// La cabecera se borra **primero** y condicionada a que no esté facturada. Al
// revés, si el generador reclamaba el pedido justo después de la comprobación,
// quedaba una factura en borrador cuyo pedido ya no existía y que el barrido de
// reconciliación no podía liberar, porque la marca que lo relaciona con la
// factura se iba con la cabecera. Perder el borrado de alguna línea después deja
// líneas huérfanas, que son un estado ya conocido y con script de limpieza.
router.delete('/pedidos', async (req, res) => {
  const id = req.body?.Id != null ? String(req.body.Id).trim() : req.query?.id != null ? String(req.query.id).trim() : '';
  if (!id) return res.status(400).json({ error: 'Id es obligatorio para borrar' });
  try {
    const cabecera = await getCabeceraPedido(id);
    const estadoExistente = cabecera ? String(cabecera.Estado ?? '') : null;
    if (estadoExistente != null) {
      // Borrar un pedido ya enviado requiere el permiso reforzado; borrar un
      // borrador requiere el permiso de borrado general.
      const permisoNecesario = estadoExistente && estadoExistente !== ESTADO_BORRADOR
        ? 'pedidos.borrar_enviado'
        : 'pedidos.borrar';
      if (!(await hasPermission(req.user, permisoNecesario))) {
        return res.status(403).json({ error: 'No tienes permiso para borrar este pedido' });
      }
      // Borrarlo dejaría la factura con líneas que ya no existen en ningún sitio.
      const bloqueoFacturado = errorPedidoFacturado(cabecera, 'borrarlo');
      if (bloqueoFacturado) return res.status(409).json({ error: bloqueoFacturado });
      try {
        await docClient.send(new DeleteCommand({
          TableName: tables.pedidos,
          Key: { Id: id },
          ConditionExpression: `attribute_exists(Id) AND ${CONDICION_SIN_FACTURAR}`,
        }));
      } catch (err) {
        if (err?.name !== 'ConditionalCheckFailedException') throw err;
        const conflicto = await motivoConflictoPedido(id, 'borrarlo');
        return res.status(conflicto.status).json({ error: conflicto.error });
      }
    }
    let lastKey = null;
    do {
      const q = await docClient.send(new QueryCommand({
        TableName: tables.pedidosLineas,
        KeyConditionExpression: 'PedidoId = :pid',
        ExpressionAttributeValues: { ':pid': id },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      for (const linea of q.Items || []) {
        const pid = String(linea.PedidoId ?? id);
        const li = linea.LineaIndex != null ? String(linea.LineaIndex).trim() : '';
        if (!li) continue;
        await docClient.send(new DeleteCommand({
          TableName: tables.pedidosLineas,
          Key: { PedidoId: pid, LineaIndex: li },
        }));
      }
      lastKey = q.LastEvaluatedKey || null;
    } while (lastKey);

    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar pedido' });
  }
});

// GET /pedidos/:pedidoId/rappel-preview?productId=&cantidad=
// Calcula total aportación/rappel según acuerdo activo y fecha del pedido.
router.get('/pedidos/:pedidoId/rappel-preview', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  const productId = String(req.query.productId ?? '').trim();
  const cantidad = typeof req.query.cantidad === 'number'
    ? req.query.cantidad
    : parseFloat(String(req.query.cantidad ?? '0').replace(',', '.')) || 0;
  if (!pedidoId) return res.status(400).json({ error: 'pedidoId obligatorio' });
  if (!productId) return res.status(400).json({ error: 'productId obligatorio' });
  try {
    const got = await docClient.send(new GetCommand({
      TableName: tables.pedidos,
      Key: { Id: pedidoId },
      ProjectionExpression: 'Fecha',
    }));
    if (!got.Item) return res.status(404).json({ error: 'Pedido no encontrado' });
    const fechaPedido = String(got.Item.Fecha ?? '').trim();
    const totalAportacionUnitaria = await resolveTotalAportacionUnitaria(productId, fechaPedido);
    const totalRappel = cantidad * totalAportacionUnitaria;
    res.json({
      ok: true,
      fechaPedido,
      totalAportacionUnitaria,
      totalRappel,
    });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al calcular rappel' });
  }
});

// GET /pedidos/:pedidoId/lineas
router.get('/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  if (!pedidoId) return res.status(400).json({ error: 'pedidoId obligatorio' });
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: tables.pedidosLineas,
      KeyConditionExpression: 'PedidoId = :pid',
      ExpressionAttributeValues: { ':pid': pedidoId },
    }));
    const items = (result.Items || []).sort((a, b) =>
      String(a.LineaIndex ?? '').localeCompare(String(b.LineaIndex ?? ''))
    );
    res.json({ lineas: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar líneas del pedido' });
  }
});

// GET /pedidos/:pedidoId/details
router.get('/pedidos/:pedidoId/details', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  if (!pedidoId) return res.status(400).json({ error: 'pedidoId obligatorio' });
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: tables.pedidosLineas,
      KeyConditionExpression: 'PedidoId = :pid',
      ExpressionAttributeValues: { ':pid': pedidoId },
    }));
    const items = (result.Items || []).sort((a, b) =>
      String(a.LineaIndex ?? '').localeCompare(String(b.LineaIndex ?? ''))
    );
    res.json({ details: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar detalles del pedido' });
  }
});

// POST /pedidos/:pedidoId/lineas
router.post('/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  if (!pedidoId) return res.status(400).json({ error: 'pedidoId obligatorio' });
  const body = req.body || {};
  try {
    const cabecera = await getCabeceraPedido(pedidoId);
    // Añadir líneas a un pedido ya enviado solo lo puede hacer el almacén central.
    const estadoPadre = cabecera ? String(cabecera.Estado ?? '') : null;
    if (estadoPadre && estadoPadre !== ESTADO_BORRADOR) {
      if (!(await hasPermission(req.user, 'pedidos.editar_enviado'))) {
        return res.status(403).json({ error: 'No puedes añadir líneas a un pedido ya enviado' });
      }
    }
    // Una línea más es más importe del que ya se facturó.
    const bloqueoFacturado = errorPedidoFacturado(cabecera, 'añadirle líneas');
    if (bloqueoFacturado) return res.status(409).json({ error: bloqueoFacturado });

    const result = await docClient.send(new QueryCommand({
      TableName: tables.pedidosLineas,
      KeyConditionExpression: 'PedidoId = :pid',
      ExpressionAttributeValues: { ':pid': pedidoId },
    }));
    const existing = result.Items || [];
    const maxIdx = existing.reduce((m, i) => {
      const n = parseInt(String(i.LineaIndex ?? '-1'), 10);
      return Number.isNaN(n) ? m : Math.max(m, n);
    }, -1);
    const lineaIndex = String(maxIdx + 1);
    const cantidad = typeof body.Cantidad === 'number' ? body.Cantidad : parseFloat(String(body.Cantidad ?? 0)) || 0;
    const precioUnitario = typeof body.PrecioUnitario === 'number' ? body.PrecioUnitario : parseFloat(String(body.PrecioUnitario ?? 0)) || 0;
    // Precio de venta CONGELADO: se fija el % de beneficio vigente en este momento
    // y se guarda el precio resultante para que el total del albarán no cambie
    // si luego se modifica el % global.
    const pctBeneficio = await getPorcentajeBeneficio();
    const precioVenta = precioUnitario * (1 + pctBeneficio / 100);
    const totalLinea = cantidad * precioVenta;
    const vatRate = body.VatRate != null ? (typeof body.VatRate === 'number' ? body.VatRate : parseFloat(String(body.VatRate)) || 0) : undefined;

    const productId = String(body.ProductId ?? '').trim();
    const fechaPedido = String(cabecera?.Fecha ?? '').trim();
    // En devoluciones se calcula el MISMO rappel que una compra (aportación del
    // producto en la fecha). Así, al restarse en el informe, anula el rappel que
    // generó la compra original (neto = 0 para una botella comprada y devuelta).
    const totalAportacionUnitaria = productId
      ? await resolveTotalAportacionUnitaria(productId, fechaPedido)
      : 0;
    const totalRappelBody = body.TotalRappel != null
      ? (typeof body.TotalRappel === 'number' ? body.TotalRappel : parseFloat(String(body.TotalRappel)) || 0)
      : 0;
    const totalRappel = totalAportacionUnitaria > 0
      ? cantidad * totalAportacionUnitaria
      : totalRappelBody;

    const item = {
      PedidoId: pedidoId,
      LineaIndex: lineaIndex,
      ProductId: productId,
      ProductoNombre: String(body.ProductoNombre ?? '').trim(),
      Cantidad: cantidad,
      PrecioUnitario: precioUnitario,
      PorcentajeBeneficioAplicado: pctBeneficio,
      PrecioVenta: precioVenta,
      TotalLinea: totalLinea,
      Preparada: false,
      ...(totalAportacionUnitaria > 0 && { TotalAportacionUnitaria: totalAportacionUnitaria }),
      TotalRappel: totalRappel,
      ...(vatRate != null && !Number.isNaN(vatRate) && { VatRate: vatRate }),
      PurchaseUnitId: body.PurchaseUnitId != null ? String(body.PurchaseUnitId).trim() : undefined,
      PurchaseUnitName: body.PurchaseUnitName != null ? String(body.PurchaseUnitName).trim() : undefined,
      Notas: body.Notas != null ? String(body.Notas).trim() : undefined,
    };
    const reserva = await reservarEdicionLineas(pedidoId, 'añadirle líneas');
    if (!reserva.ok) return res.status(reserva.status).json({ error: reserva.error });
    await docClient.send(new PutCommand({ TableName: tables.pedidosLineas, Item: item }));
    await confirmarEdicionLineas(pedidoId);
    res.json({ ok: true, linea: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al crear línea' });
  }
});

// PUT /pedidos/:pedidoId/lineas
router.put('/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  const lineaIndex = req.body?.LineaIndex != null ? String(req.body.LineaIndex).trim() : '';
  if (!pedidoId || !lineaIndex) return res.status(400).json({ error: 'pedidoId y LineaIndex obligatorios' });
  const body = req.body || {};
  try {
    const got = await docClient.send(new GetCommand({
      TableName: tables.pedidosLineas,
      Key: { PedidoId: pedidoId, LineaIndex: lineaIndex },
    }));
    const existing = got.Item || {};

    // ¿La petición solo marca/desmarca "Preparada"? Esa es la operación normal
    // del almacén al preparar y no debe exigir permiso de edición de contenido.
    const camposContenido = ['Cantidad', 'PrecioUnitario', 'ProductId', 'ProductoNombre', 'VatRate', 'TotalRappel', 'PurchaseUnitId', 'PurchaseUnitName', 'Notas'];
    const soloPreparada = body.Preparada != null && !camposContenido.some((c) => body[c] != null);

    const cabecera = await getCabeceraPedido(pedidoId);
    const estadoPadre = cabecera ? String(cabecera.Estado ?? '') : null;
    if (!soloPreparada) {
      if (estadoPadre && estadoPadre !== ESTADO_BORRADOR) {
        if (!(await hasPermission(req.user, 'pedidos.editar_enviado'))) {
          return res.status(403).json({ error: 'No puedes modificar las líneas de un pedido ya enviado' });
        }
      }
    }
    // También se bloquea el marcado de preparación: desmarcar una línea saca el
    // pedido de 'Completado' y le borra la fecha con la que se decidió el mes de
    // la factura, y esta escritura recalcula `TotalLinea` aunque solo venga
    // `Preparada` (las líneas antiguas sin `PrecioVenta` lo rehacen).
    const bloqueoFacturado = errorPedidoFacturado(
      cabecera,
      soloPreparada ? 'cambiar la preparación de sus líneas' : 'cambiar sus líneas',
    );
    if (bloqueoFacturado) return res.status(409).json({ error: bloqueoFacturado });

    const cantidad = body.Cantidad != null ? (typeof body.Cantidad === 'number' ? body.Cantidad : parseFloat(String(body.Cantidad)) || 0) : (existing.Cantidad ?? 0);
    const precioUnitario = body.PrecioUnitario != null ? (typeof body.PrecioUnitario === 'number' ? body.PrecioUnitario : parseFloat(String(body.PrecioUnitario)) || 0) : (existing.PrecioUnitario ?? 0);
    // Precio de venta congelado: se conserva el de la línea; si cambia el precio
    // base (re-selección de producto) se recalcula con el % ya aplicado a la línea.
    const pctAplicado = existing.PorcentajeBeneficioAplicado != null ? Number(existing.PorcentajeBeneficioAplicado) : null;
    let precioVenta;
    if (body.PrecioUnitario != null && pctAplicado != null) {
      precioVenta = precioUnitario * (1 + pctAplicado / 100);
    } else if (existing.PrecioVenta != null) {
      precioVenta = Number(existing.PrecioVenta);
    } else {
      precioVenta = precioUnitario * (1 + (pctAplicado ?? 0) / 100);
    }
    const totalLinea = cantidad * precioVenta;
    const preparada = body.Preparada != null ? !!body.Preparada : !!(existing.Preparada ?? false);

    const aportUnitExistente = existing.TotalAportacionUnitaria != null
      ? Number(existing.TotalAportacionUnitaria)
      : null;
    const aportUnit = aportUnitExistente != null && Number.isFinite(aportUnitExistente)
      ? aportUnitExistente
      : (Number(existing.Cantidad) > 0 && existing.TotalRappel != null
        ? Number(existing.TotalRappel) / Number(existing.Cantidad)
        : 0);
    const totalRappel = aportUnit > 0 ? cantidad * aportUnit : (existing.TotalRappel ?? 0);

    const item = {
      PedidoId: pedidoId,
      LineaIndex: lineaIndex,
      ProductId: body.ProductId != null ? String(body.ProductId).trim() : String(existing.ProductId ?? ''),
      ProductoNombre: body.ProductoNombre != null ? String(body.ProductoNombre).trim() : String(existing.ProductoNombre ?? ''),
      Cantidad: cantidad,
      PrecioUnitario: precioUnitario,
      ...(pctAplicado != null && { PorcentajeBeneficioAplicado: pctAplicado }),
      PrecioVenta: precioVenta,
      TotalLinea: totalLinea,
      Preparada: preparada,
      ...(aportUnitExistente != null && Number.isFinite(aportUnitExistente) && { TotalAportacionUnitaria: aportUnitExistente }),
      TotalRappel: typeof totalRappel === 'number' && Number.isFinite(totalRappel) ? totalRappel : 0,
      PurchaseUnitId: body.PurchaseUnitId != null ? String(body.PurchaseUnitId).trim() : (existing.PurchaseUnitId ?? undefined),
      PurchaseUnitName: body.PurchaseUnitName != null ? String(body.PurchaseUnitName).trim() : (existing.PurchaseUnitName ?? undefined),
      Notas: body.Notas != null ? String(body.Notas).trim() : (existing.Notas ?? undefined),
      ...((body.VatRate ?? existing.VatRate) != null && {
        VatRate: body.VatRate != null ? (typeof body.VatRate === 'number' ? body.VatRate : parseFloat(String(body.VatRate)) || 0) : existing.VatRate,
      }),
    };
    const reserva = await reservarEdicionLineas(
      pedidoId,
      soloPreparada ? 'cambiar la preparación de sus líneas' : 'cambiar sus líneas',
    );
    if (!reserva.ok) return res.status(reserva.status).json({ error: reserva.error });
    await docClient.send(new PutCommand({ TableName: tables.pedidosLineas, Item: item }));
    await confirmarEdicionLineas(pedidoId);

    // Si la operación tocó el flag "Preparada", recalculamos el estado del pedido
    // (Enviado → Pendiente → Completado) para reflejar el avance del almacén.
    let estadoPedido;
    if (body.Preparada != null) {
      await recomputarEstadoPorPreparacion(pedidoId, req.user?.email);
      estadoPedido = (await getEstadoPedido(pedidoId)) ?? undefined;
    }

    res.json({ ok: true, linea: item, ...(estadoPedido != null && { estadoPedido }) });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar línea' });
  }
});

// DELETE /pedidos/:pedidoId/lineas
router.delete('/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  const lineaIndex = req.body?.LineaIndex != null ? String(req.body.LineaIndex).trim() : req.query?.lineaIndex != null ? String(req.query.lineaIndex).trim() : '';
  if (!pedidoId || !lineaIndex) return res.status(400).json({ error: 'pedidoId y LineaIndex obligatorios' });
  try {
    const cabecera = await getCabeceraPedido(pedidoId);
    // Borrar líneas de un pedido ya enviado requiere el permiso reforzado.
    const estadoPadre = cabecera ? String(cabecera.Estado ?? '') : null;
    if (estadoPadre && estadoPadre !== ESTADO_BORRADOR) {
      if (!(await hasPermission(req.user, 'pedidos.borrar_enviado'))) {
        return res.status(403).json({ error: 'No puedes borrar líneas de un pedido ya enviado' });
      }
    }
    // Una línea menos es menos importe del que ya se facturó.
    const bloqueoFacturado = errorPedidoFacturado(cabecera, 'quitarle líneas');
    if (bloqueoFacturado) return res.status(409).json({ error: bloqueoFacturado });

    const reserva = await reservarEdicionLineas(pedidoId, 'quitarle líneas');
    if (!reserva.ok) return res.status(reserva.status).json({ error: reserva.error });
    await docClient.send(new DeleteCommand({
      TableName: tables.pedidosLineas,
      Key: { PedidoId: pedidoId, LineaIndex: lineaIndex },
    }));
    await confirmarEdicionLineas(pedidoId);
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar línea' });
  }
});

export default router;
