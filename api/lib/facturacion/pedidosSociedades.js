/**
 * Maquinaria común de las facturaciones mensuales que nacen de un pedido de
 * almacén: la venta de la mercancía y el abono del rappel.
 *
 * Los dos flujos facturan **los mismos pedidos entre las mismas dos sociedades**
 * y solo se diferencian en el importe, el signo y la serie. Si cada uno
 * resolviera por su cuenta quién sirve y quién recibe, bastaría con corregir un
 * criterio en un sitio y olvidarlo en el otro para que la venta fuera a una
 * sociedad y su abono a otra. Por eso todo lo que decide **emisor, receptor,
 * ventana temporal y tipo de IVA** vive aquí y no se duplica.
 *
 * Lo que cada dominio pone de su parte: qué campo de la línea del pedido se
 * factura, con qué signo, en qué serie y con qué marca.
 */

import { QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { formatId6 } from '../usuarioLocales.js';
import { esAlmacenGeneral, normalizarNombreAlmacen } from '../pedidos/almacenGeneral.js';
import {
  cargarEmpresasPorId,
  condicionRevision,
  corteSeleccion,
  datosEmpresaFiscal,
  round2,
  scanTodo,
} from './facturacionPeriodica.js';

export const ESTADO_COMPLETADO = 'Completado';
export const TIPO_DEVOLUCION = 'Devolucion';

/** Campo del maestro de locales con los nombres de sus almacenes, separados por comas. */
export const CAMPO_ALMACENES_LOCAL = 'almacen origen';

// ─── Fechas y periodos ───

/** Primer día del periodo: el inicio de la ventana de selección. */
export function inicioSeleccion(periodo) {
  return `${periodo}-01`;
}

/** Corte de selección: primer día del mes siguiente al periodo (excluido). */
export function cortePedidos(periodo) {
  return corteSeleccion(periodo);
}

/** Normaliza una fecha de pedido (ISO o dd/mm/aaaa) a 'YYYY-MM-DD'; '' si no se reconoce. */
export function fechaPedidoToIso(fecha) {
  const s = String(fecha ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m2) return `20${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  return '';
}

/**
 * Fecha que decide a qué mes pertenece el pedido: la del OK del almacén y, si
 * falta, la del pedido.
 *
 * Es la misma regla que usa el informe de ventas por empresa
 * (`GET /pedidos/abonos?modo=ventas`), y a propósito: si los dos no contaran los
 * mismos pedidos en el mismo mes, el usuario tendría dos cifras distintas del
 * mismo periodo y ninguna forma de saber cuál creer. Un pedido puede nacer
 * `Completado` sin `CompletadoEn` (alta directa en ese estado) y entonces la
 * referencia es `Fecha`.
 *
 * `CompletadoEn` es un ISO en UTC y se recorta a 10 caracteres, así que la
 * frontera del mes es a las 00:00 UTC: algo completado el último día del mes a
 * última hora local ya cae en el periodo siguiente. Es lo que hace el informe y
 * no pierde nada, porque el pedido entra en la tanda siguiente.
 */
export function fechaReferencia(pedido) {
  const completadoEn = String(pedido?.CompletadoEn ?? '').trim();
  if (completadoEn) {
    const iso = fechaPedidoToIso(completadoEn.slice(0, 10));
    if (iso) return iso;
  }
  return fechaPedidoToIso(pedido?.Fecha) || String(pedido?.Fecha ?? '').trim().slice(0, 10);
}

/** dd/mm/aaaa a partir de un yyyy-mm-dd. Vacío si no hay fecha. */
export function fechaCorta(valor) {
  const s = String(valor ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return '';
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
}

// ─── Normalización ───

/**
 * `id_empresa` con el padding del maestro, o '' si no hay valor: '000000' no es
 * una sociedad válida y tratarlo como tal inventaría un vínculo inexistente.
 */
export function normalizarIdEmpresa(val) {
  const s = val != null ? String(val).trim() : '';
  if (!s) return '';
  const norm = formatId6(s);
  return norm === '000000' ? '' : norm;
}

/**
 * Nombre de almacén comparable. Se reexporta el del criterio compartido
 * (`lib/pedidos/almacenGeneral.js`) en vez de tener otra copia: si las dos
 * normalizaciones divergieran, el permiso que exige `api/routes/pedidos.js` y la
 * sociedad emisora que resuelve esta facturación dejarían de hablar del mismo
 * almacén.
 */
export const normalizarNombre = normalizarNombreAlmacen;

/** Clave de agrupación de una factura: el par de sociedades. */
export function claveGrupo(idEmisora, idReceptora) {
  return `${idEmisora}#${idReceptora}`;
}

// ─── Lectura de maestros ───

/** Separa la lista de almacenes del local (campo separado por comas). */
function parseAlmacenesLocal(val) {
  if (val == null || String(val).trim() === '') return [];
  return String(val)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function cargarLocales() {
  const items = await scanTodo(
    tables.locales,
    'id_Locales, nombre, id_empresa, #almacenes',
    { '#almacenes': CAMPO_ALMACENES_LOCAL }
  );
  return items
    .map((l) => ({
      id: String(l.id_Locales ?? '').trim(),
      nombre: String(l.nombre ?? '').trim(),
      id_empresa: normalizarIdEmpresa(l.id_empresa),
      almacenes: parseAlmacenesLocal(l[CAMPO_ALMACENES_LOCAL]),
    }))
    .filter((l) => l.id !== '');
}

/** Maestro de almacenes indexado por `Id`, que es lo que viaja en `AlmacenOrigenId`. */
async function cargarAlmacenes() {
  const items = await scanTodo(tables.almacenes, 'Id, Nombre');
  const porId = new Map();
  for (const a of items) {
    const id = String(a.Id ?? '').trim();
    if (!id) continue;
    porId.set(id, { id, nombre: String(a.Nombre ?? '').trim() });
  }
  return porId;
}

/** Primer valor que sea un porcentaje de IVA usable (0 incluido), o null. */
function primerPorcentajeValido(...valores) {
  for (const v of valores) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return round2(n);
  }
  return null;
}

/**
 * Tipos de IVA del maestro de productos, en porcentaje, indexados por `ProductId`.
 *
 * La prioridad reproduce la de la pantalla que crea las líneas del pedido
 * (`ultimo_iva_compra`, el IVA con el que el proveedor nos facturó ese producto,
 * y si no el IVA de venta de Ágora): así el IVA que se factura es el mismo que
 * el usuario vio al montar el pedido. `PurchaseVatPercent` es el nombre antiguo
 * de `ultimo_iva_compra` en filas que aún no se han resincronizado.
 *
 * Se guarda `null` cuando el producto no tiene ninguno de los tres, para poder
 * distinguir "no se sabe" de "0 %", que es un tipo válido.
 */
async function cargarIvaProductos() {
  const porId = new Map();
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.agoraProducts,
        KeyConditionExpression: 'PK = :pk',
        ProjectionExpression: 'SK, ultimo_iva_compra, PurchaseVatPercent, VatPercent',
        ExpressionAttributeValues: { ':pk': 'GLOBAL' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    for (const p of r.Items || []) {
      const id = String(p.SK ?? '').trim();
      if (!id || id === '__meta__') continue;
      porId.set(id, primerPorcentajeValido(p.ultimo_iva_compra, p.PurchaseVatPercent, p.VatPercent));
    }
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return porId;
}

/**
 * Maestros que necesitan los dos flujos para resolver emisor, receptor e IVA.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * El mapa almacén → locales se construye por **igualdad exacta** de nombre
 * normalizado, no por inclusión.
 *
 * El local guarda **nombres** de almacén en un campo de texto separado por comas,
 * así que hay que casar por nombre. Casar por inclusión —"el nombre del almacén
 * contiene lo que puso el local"— parece más tolerante y lo que hace es atribuir
 * mercancía a quien no la sirvió, en silencio: si solo casa un local, la sociedad
 * emisora se resuelve sin avisar de nada y la factura sale a nombre del local
 * equivocado. Solo el caso ambiguo (varios locales) se excluía.
 *
 * Con los datos reales del grupo, la inclusión produce exactamente un acierto
 * dudoso y un error grave:
 *  - `ALMACEN GENERAL NEPTUNO` casaba con el local de la distribuidora, porque
 *    ese local tiene `Almacén General` en su campo y "Almacén General" está
 *    contenido en "Almacen General Neptuno". Resultado: la mercancía servida
 *    desde Neptuno se facturaba a nombre de la sociedad de la distribuidora.
 *  - `ALMACEN DIDO BARRA ISLA` casaba con DIDO por contener `ALMACEN DIDO`.
 *    Acertaba, pero por accidente: lo que pasa de verdad es que a ese local le
 *    falta ese almacén en su campo, y el arreglo está en el maestro.
 *
 * Los 34 almacenes del maestro llevan nombres completos y todos casan por
 * igualdad, así que el cambio no excluye nada que hoy se facture: los tres
 * almacenes que aparecen en pedidos completados casan igual con los dos
 * criterios. Ninguna atribución real se pierde y desaparece el falso positivo.
 *
 * La inclusión se conserva **solo para explicar la exclusión**: cuando un almacén
 * no casa con nadie, se calcula qué local habría casado por parecido y se ofrece
 * como pista en el detalle. Informa sin facturar a ciegas, que es la diferencia.
 */
export async function cargarContextoPedidos() {
  const [locales, almacenesPorId, empresasPorId, ivaPorProducto] = await Promise.all([
    cargarLocales(),
    cargarAlmacenes(),
    cargarEmpresasPorId(),
    cargarIvaProductos(),
  ]);
  const localesPorId = new Map(locales.map((l) => [l.id, l]));
  const localesPorAlmacen = new Map();
  const localesAproximadosPorAlmacen = new Map();
  for (const [id, almacen] of almacenesPorId) {
    const nombreAlmacen = normalizarNombre(almacen.nombre);
    if (!nombreAlmacen) continue;
    const exactos = locales.filter((l) =>
      l.almacenes.some((n) => normalizarNombre(n) !== '' && normalizarNombre(n) === nombreAlmacen)
    );
    if (exactos.length > 0) {
      localesPorAlmacen.set(id, exactos);
      continue;
    }
    // Ningún local declara este almacén con su nombre exacto. Se apunta a quién
    // se le parece, para poder decirlo en el motivo de exclusión.
    const parecidos = locales.filter((l) =>
      l.almacenes.some((n) => {
        const nNorm = normalizarNombre(n);
        return nNorm !== '' && nombreAlmacen.includes(nNorm);
      })
    );
    if (parecidos.length > 0) localesAproximadosPorAlmacen.set(id, parecidos);
  }
  return {
    locales,
    localesPorId,
    localesPorAlmacen,
    localesAproximadosPorAlmacen,
    almacenesPorId,
    empresasPorId,
    ivaPorProducto,
  };
}

// ─── Lectura de pedidos ───

/** Atributos de la cabecera que necesitan la planificación y el reclamo. */
const PROYECCION_PEDIDO =
  'Id, Estado, Tipo, Fecha, CompletadoEn, LocalId, AlmacenOrigenId, AlmacenDestinoId,' +
  ' factura_id_empresa_local, lineas_rev';

/**
 * Cabecera de los pedidos completados que aún no tienen la marca indicada.
 *
 * `Igp_Pedidos` solo tiene clave de partición (`Id`), así que no hay más opción
 * que recorrerla. El `FilterExpression` se aplica **después** de leer, así que
 * la tabla se paga entera como lectura y lo que ahorra es red; lo que evita
 * traerse notas y campos de exportación es el `ProjectionExpression`.
 *
 * La ventana de fechas se aplica en memoria porque la fecha de referencia es
 * derivada (`CompletadoEn` y, si falta, `Fecha`, que además admite dd/mm/aaaa) y
 * no se puede expresar como condición de DynamoDB. Aprovechando ese recorrido,
 * se cuentan también los pedidos anteriores al periodo que siguen sin la marca:
 * son huecos que solo se recuperan volviendo a generar su periodo, y sin este
 * aviso nadie se enteraría.
 *
 * @param {string} periodo
 * @param {string} campoMarca `factura_ventas_id` o `factura_rappel_id`
 */
export async function buscarPedidosCandidatos(periodo, campoMarca) {
  const inicio = inicioSeleccion(periodo);
  const corte = cortePedidos(periodo);
  const candidatos = [];
  const anterioresPorPeriodo = new Map();
  let lastKey = null;
  do {
    const r = await docClient.send(
      new ScanCommand({
        TableName: tables.pedidos,
        FilterExpression: `Estado = :completado AND attribute_not_exists(${campoMarca})`,
        ProjectionExpression: PROYECCION_PEDIDO,
        ExpressionAttributeValues: { ':completado': ESTADO_COMPLETADO },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    for (const p of r.Items || []) {
      const fecha = fechaReferencia(p);
      if (!fecha) continue;
      if (fecha >= inicio && fecha < corte) {
        candidatos.push({ ...p, fecha_referencia: fecha });
      } else if (fecha < inicio) {
        const per = fecha.slice(0, 7);
        anterioresPorPeriodo.set(per, (anterioresPorPeriodo.get(per) ?? 0) + 1);
      }
    }
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);

  candidatos.sort(
    (a, b) =>
      String(a.fecha_referencia).localeCompare(String(b.fecha_referencia)) ||
      String(a.Id).localeCompare(String(b.Id))
  );
  const anteriores = [...anterioresPorPeriodo.entries()]
    .map(([per, pedidos]) => ({ periodo: per, pedidos }))
    .sort((a, b) => a.periodo.localeCompare(b.periodo));
  return { candidatos, anteriores };
}

/** Líneas de un pedido, con los dos importes facturables y el IVA. */
export async function buscarLineasPedido(pedidoId) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.pedidosLineas,
        KeyConditionExpression: 'PedidoId = :pid',
        ProjectionExpression:
          'PedidoId, LineaIndex, ProductId, ProductoNombre, Cantidad, TotalLinea, TotalRappel, VatRate',
        ExpressionAttributeValues: { ':pid': pedidoId },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Pedidos ya marcados hace más del margen de reconciliación.
 *
 * La antigüedad se mide con el campo de fecha de la marca, que solo escribe el
 * reclamo. Si la marca no la tiene, no hay forma de saber si es reciente, pero
 * tampoco hay ejecución en curso que proteger: el reclamo escribe siempre las
 * dos cosas.
 */
export async function buscarPedidosMarcados(campos, limite) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new ScanCommand({
        TableName: tables.pedidos,
        FilterExpression:
          `attribute_exists(${campos.id})` +
          ` AND (attribute_not_exists(${campos.fecha}) OR ${campos.fecha} < :lim)`,
        ProjectionExpression: `Id, LocalId, ${campos.id}, ${campos.periodo}, ${campos.ejecucion}, ${campos.fecha}`,
        ExpressionAttributeValues: { ':lim': limite },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

// ─── Escrituras sobre los pedidos ───

/**
 * Testigo de que la fecha con la que se decidió el periodo sigue vigente.
 *
 * Si el pedido tenía `CompletadoEn`, se compara; si no lo tenía, se exige que
 * siga sin tenerlo y que `Fecha` no haya cambiado, porque entonces es `Fecha` la
 * que decide el mes. Sin esto, un pedido podría facturarse en un periodo y que
 * su fecha cambiara después al que ya no le corresponde.
 */
function condicionFechaReferencia(pedido) {
  const completadoEn = String(pedido?.CompletadoEn ?? '').trim();
  if (completadoEn) {
    return {
      expresion: 'CompletadoEn = :compLeida',
      valores: { ':compLeida': pedido.CompletadoEn },
    };
  }
  return {
    expresion: 'attribute_not_exists(CompletadoEn) AND Fecha = :fechaLeida',
    valores: { ':fechaLeida': pedido?.Fecha ?? '' },
  };
}

/**
 * Testigo de que un campo de la cabecera sigue teniendo el valor con el que se
 * decidió el contenido de la factura.
 *
 * Distingue tres estados, y la distinción importa: si el campo no estaba, el
 * testigo es su ausencia, porque "sigue sin estar" y "ahora tiene valor" son
 * situaciones distintas y la segunda cambia la factura. Un atributo escrito como
 * `null` sí existe, así que se compara por valor y no por ausencia.
 */
function condicionValorLeido(pedido, campo, alias) {
  const valor = pedido?.[campo];
  if (valor === undefined) {
    return { expresion: `attribute_not_exists(${campo})`, valores: {} };
  }
  return { expresion: `${campo} = ${alias}`, valores: { [alias]: valor } };
}

/**
 * Campos de la cabecera de los que depende **el contenido** del documento, y por
 * eso tienen que estar en la condición del reclamo. El criterio es ese y no otro:
 * si cambiarlo entre la lectura y el reclamo produce una factura distinta de la
 * previsualizada, va aquí.
 *
 * - `LocalId`: el local que recibió, que decide la sociedad receptora, su nombre
 *   en el documento y el agrupamiento por local.
 * - `AlmacenOrigenId`: el almacén que sirvió, que decide la sociedad **emisora**.
 * - `factura_id_empresa_local`: la sociedad del local congelada al completar el
 *   pedido. Tiene prioridad sobre el maestro, así que si aparece o cambia, la
 *   receptora cambia con ella.
 * - `Tipo`: distingue pedido de devolución. En ventas decide si se factura y en
 *   el rappel invierte el signo con el que el pedido entra en el abono.
 *
 * `Estado`, `CompletadoEn`/`Fecha` y `lineas_rev` también condicionan, pero cada
 * uno tiene su testigo propio (ver más abajo) porque no es una igualdad simple.
 *
 * Fuera quedan los campos de los que la factura no depende: `AlmacenDestinoId`,
 * las notas o cualquier dato de exportación. Meterlos solo haría que un cambio
 * inocuo descartase el pedido del lote.
 */
const CAMPOS_QUE_DEFINEN_LA_FACTURA = [
  ['LocalId', ':localLeido'],
  ['AlmacenOrigenId', ':almacenLeido'],
  ['factura_id_empresa_local', ':empresaLocalLeida'],
  ['Tipo', ':tipoLeido'],
];

/**
 * Reclama un pedido para una factura. Esta escritura condicional es la garantía
 * de que nada se factura dos veces ni con un contenido distinto del
 * previsualizado: falla —y el pedido se descarta del lote— si otra ejecución lo
 * reclamó, si dejó de estar completado, si su fecha de referencia cambió, si sus
 * líneas se han reescrito o si cambió cualquiera de los campos con los que se
 * resolvieron emisora, receptora y sentido del documento.
 *
 * Esa última parte es la que cierra una carrera real: el `PUT` de pedidos puede
 * corregir `LocalId` o `AlmacenOrigenId` de un pedido ya completado sin tocar
 * `CompletadoEn` ni `lineas_rev`, y sin marca todavía puesta devuelve 200 con
 * razón. Sin estos testigos el reclamo pasaba igual y la factura salía contra la
 * sociedad equivocada por mercancía entregada en otro local.
 *
 * El testigo del importe es `lineas_rev`, el contador que `api/routes/pedidos.js`
 * sube con ADD en toda escritura de línea: la cabecera no tiene ningún otro campo
 * que se mueva al editar una línea.
 *
 * Las marcas de venta y de rappel son independientes a propósito: un pedido
 * puede tener la venta facturada y el rappel sin abonar, y `pedidos.js` ya
 * bloquea sus modificaciones con cualquiera de las dos puesta. Así que la
 * condición solo mira **su** campo y nunca el del otro flujo.
 */
export async function reclamarPedido(
  pedido,
  campos,
  { idFactura, periodo, ejecucion, fecha, idEmpresaEmisora }
) {
  const rev = condicionRevision(pedido, 'lineas_rev');
  const fechaRef = condicionFechaReferencia(pedido);
  const definitorios = CAMPOS_QUE_DEFINEN_LA_FACTURA.map(([campo, alias]) =>
    condicionValorLeido(pedido, campo, alias)
  );
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tables.pedidos,
        Key: { Id: pedido.Id },
        UpdateExpression:
          `SET ${campos.id} = :fid, ${campos.periodo} = :per, ${campos.fecha} = :fec,` +
          ` ${campos.ejecucion} = :eje, ${campos.idEmpresa} = :emp`,
        ConditionExpression: [
          'attribute_exists(Id)',
          `attribute_not_exists(${campos.id})`,
          'Estado = :completado',
          fechaRef.expresion,
          rev.expresion,
          ...definitorios.map((c) => c.expresion),
        ].join(' AND '),
        ExpressionAttributeValues: {
          ':fid': idFactura,
          ':per': periodo,
          ':fec': fecha,
          ':eje': ejecucion,
          ':emp': idEmpresaEmisora,
          ':completado': ESTADO_COMPLETADO,
          ...fechaRef.valores,
          ...rev.valores,
          ...Object.assign({}, ...definitorios.map((c) => c.valores)),
        },
      })
    );
    return { ok: true };
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return { ok: false };
    throw err;
  }
}

/** Quita la marca de un pedido. Devuelve true si la quitó. */
export async function liberarPedido(pedido, campos, idFactura) {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tables.pedidos,
        Key: { Id: pedido.Id },
        UpdateExpression: `REMOVE ${Object.values(campos).join(', ')}`,
        ConditionExpression: `attribute_exists(Id) AND ${campos.id} = :fid`,
        ExpressionAttributeValues: { ':fid': idFactura },
      })
    );
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

// ─── Resolución de sociedades ───

/** Motivos de exclusión comunes a los dos flujos. */
export const MOTIVOS_COMUNES = {
  almacen_origen_sin_dato: 'El pedido no dice desde qué almacén se sirvió la mercancía',
  almacen_desconocido: 'El almacén de origen del pedido no está en el maestro de almacenes',
  almacen_no_atribuible:
    'El almacén de origen no se puede atribuir a un único local, así que no se sabe qué sociedad sirvió la mercancía',
  emisora_almacen_general_sin_configurar:
    'Falta la sociedad del Almacén General en la configuración de facturación de compras',
  local_origen_sin_empresa: 'El local que sirvió la mercancía no tiene sociedad asignada (id_empresa)',
  local_sin_empresa: 'El local que recibió la mercancía no tiene sociedad asignada (id_empresa)',
  local_inexistente: 'El local que recibió la mercancía ya no existe en el maestro de locales',
  empresa_inexistente: 'La sociedad que recibe no existe en el maestro de empresas',
  empresa_emisora_inexistente: 'La sociedad que sirve no existe en el maestro de empresas',
  sociedad_sin_datos_fiscales: 'La sociedad que recibe no tiene los datos fiscales necesarios para facturarle',
  sociedad_emisora_sin_datos_fiscales: 'La sociedad que sirve no tiene los datos fiscales necesarios para facturar',
  sociedad_misma: 'Quien sirve y quien recibe son la misma sociedad, que no se factura a sí misma',
  linea_importe_negativo:
    'El pedido tiene una línea con importe negativo: facturarlo dejaría de cobrar mercancía realmente servida',
  factura_total_cero: 'El documento quedaría a 0 €',
  validacion_emision: 'El documento no pasaría la validación de emisión',
  concurrencia: 'El pedido cambió mientras se generaba el documento',
};

/**
 * Detalle de la exclusión cuando ningún local declara el almacén con su nombre
 * exacto. Si alguno lo declara de forma parcial, se dice cuál y qué hacer: es lo
 * que antes se daba por bueno en silencio y facturaba a nombre de otro.
 */
function detalleSinLocalExacto(almacen, aproximados) {
  const base = `Ningún local tiene exactamente "${almacen.nombre}" en su campo "${CAMPO_ALMACENES_LOCAL}"`;
  if (!aproximados || aproximados.length === 0) return base;
  const nombres = aproximados.map((l) => l.nombre || l.id).join(', ');
  return (
    `${base}. Por parecido de nombre encajaría con ${nombres}, pero no se atribuye por` +
    ` aproximación: si es correcto, añade "${almacen.nombre}" al campo de ese local.`
  );
}

/**
 * Sociedad que emite el documento de un pedido: la del almacén desde el que
 * salió la mercancía.
 *
 * Vale igual para la venta y para el abono del rappel: en los dos casos el
 * documento lo emite quien sirvió. Ver el razonamiento de la dirección del abono
 * en `facturarRappel.js`.
 *
 * La atribución del almacén a su local es por igualdad exacta de nombre (ver
 * `cargarContextoPedidos`). Cuando no casa nadie, el detalle propone el local que
 * se le parece: es una pista para corregir el maestro, nunca una atribución.
 *
 * @returns {{ ok: true, id_empresa, origen_clave, origen_nombre } | { ok: false, motivo, detalle? }}
 */
export function resolverEmisora(
  pedido,
  { idEmpresaAlmacenGeneral, almacenesPorId, localesPorAlmacen, localesAproximadosPorAlmacen }
) {
  const almacenId = String(pedido?.AlmacenOrigenId ?? '').trim();
  if (!almacenId) return { ok: false, motivo: 'almacen_origen_sin_dato' };
  const almacen = almacenesPorId.get(almacenId);
  if (!almacen) {
    return { ok: false, motivo: 'almacen_desconocido', detalle: `Almacén ${almacenId}` };
  }

  // El criterio del Almacén General es el compartido con `api/routes/pedidos.js`:
  // el mismo que decide si servir desde ese almacén exige permiso. Se aplica sobre
  // el maestro que esta planificación ya tiene cargado, así que no repite lectura.
  if (esAlmacenGeneral(almacen.nombre)) {
    if (!idEmpresaAlmacenGeneral) {
      return { ok: false, motivo: 'emisora_almacen_general_sin_configurar' };
    }
    return {
      ok: true,
      id_empresa: idEmpresaAlmacenGeneral,
      origen_clave: `ALMACEN#${almacen.id}`,
      origen_nombre: almacen.nombre || `Almacén ${almacen.id}`,
    };
  }

  const locales = localesPorAlmacen.get(almacenId) ?? [];
  if (locales.length !== 1) {
    return {
      ok: false,
      motivo: 'almacen_no_atribuible',
      detalle:
        locales.length === 0
          ? detalleSinLocalExacto(almacen, localesAproximadosPorAlmacen?.get(almacenId))
          : `Lo comparten ${locales.length} locales: ${locales.map((l) => l.nombre || l.id).join(', ')}`,
    };
  }
  const local = locales[0];
  if (!local.id_empresa) {
    return { ok: false, motivo: 'local_origen_sin_empresa', detalle: `Local ${local.nombre || local.id}` };
  }
  return {
    ok: true,
    id_empresa: local.id_empresa,
    origen_clave: `LOCAL#${local.id}`,
    origen_nombre: local.nombre || local.id,
  };
}

/**
 * Sociedad que recibe el documento: la del local del pedido.
 *
 * Se prefiere `factura_id_empresa_local`, congelada al completar el pedido por
 * `api/routes/pedidos.js`, y solo se cae al maestro si falta (pedidos completados
 * antes de que existiera esa congelación). Entre que se sirve la mercancía y se
 * factura el mes, un local puede cambiar de sociedad.
 * @returns {{ ok: true, id_empresa, local_id, local_nombre, congelada } | { ok: false, motivo, detalle? }}
 */
export function resolverReceptora(pedido, { localesPorId }) {
  const localId = String(pedido?.LocalId ?? '').trim();
  const local = localId ? localesPorId.get(localId) : null;
  const congelada = normalizarIdEmpresa(pedido?.factura_id_empresa_local);
  const nombre = local?.nombre || localId;
  if (congelada) {
    return { ok: true, id_empresa: congelada, local_id: localId, local_nombre: nombre, congelada: true };
  }
  if (!local) {
    return { ok: false, motivo: 'local_inexistente', detalle: `Local ${localId || 'sin indicar'}` };
  }
  if (!local.id_empresa) {
    return { ok: false, motivo: 'local_sin_empresa', detalle: `Local ${nombre}` };
  }
  return { ok: true, id_empresa: local.id_empresa, local_id: localId, local_nombre: nombre, congelada: false };
}

/** Datos fiscales completos de una sociedad, o el motivo por el que no sirve. */
export function fiscalDeSociedad(idEmpresa, empresasPorId, { emisora = false } = {}) {
  const item = empresasPorId.get(idEmpresa);
  if (!item) {
    return {
      ok: false,
      motivo: emisora ? 'empresa_emisora_inexistente' : 'empresa_inexistente',
      detalle: `La sociedad ${idEmpresa} no está en el maestro`,
    };
  }
  const fiscal = { ...datosEmpresaFiscal(item), id_empresa: idEmpresa };
  const faltan = [];
  if (!fiscal.cif) faltan.push('CIF');
  if (!fiscal.nombre) faltan.push('nombre');
  if (faltan.length > 0) {
    return {
      ok: false,
      motivo: emisora ? 'sociedad_emisora_sin_datos_fiscales' : 'sociedad_sin_datos_fiscales',
      detalle: `Falta ${faltan.join(' y ')} en el maestro de empresas`,
      nombre: fiscal.nombre,
    };
  }
  return { ok: true, fiscal };
}

// ─── IVA ───

/**
 * Tipo de IVA de una línea de pedido, en porcentaje. `null` si no se puede
 * determinar, que es un motivo de exclusión y **nunca** un 21 % por defecto:
 * inventar el tipo de una factura es inventar la cuota que se ingresa a Hacienda.
 *
 * `VatRate` se guarda en el pedido como fracción (0.10, 0.21), que es como la
 * escribe y la muestra la pantalla de compras. Se tolera que una fila antigua
 * lleve ya el porcentaje: por encima de 1 no puede ser una fracción de IVA.
 *
 * Un `VatRate` de 0 no se toma por un 0 % válido, porque la pantalla guarda
 * justamente 0 cuando el producto elegido no traía ningún IVA (el campo se queda
 * vacío y se envía como 0). En ese caso se pregunta al maestro de productos, que
 * sí distingue "no lo tengo" de "es 0".
 */
export function tipoIvaDeLinea(linea, ivaPorProducto) {
  const raw = linea?.VatRate;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return round2(n > 1 ? n : n * 100);
  }
  const productId = String(linea?.ProductId ?? '').trim();
  if (!productId) return null;
  const delMaestro = ivaPorProducto.get(productId);
  return delMaestro == null ? null : delMaestro;
}

/** ¿El IVA de esta línea ha tenido que salir del maestro de productos? */
export function ivaVieneDelMaestro(linea) {
  const n = Number(linea?.VatRate);
  return !(Number.isFinite(n) && n > 0);
}

/**
 * Importes de un pedido repartidos por tipo de IVA, o el motivo por el que no se
 * puede facturar.
 *
 * `campoImporte` es lo que distingue los dos flujos: `TotalLinea` factura la
 * mercancía y `TotalRappel` abona el incentivo. Solo cuentan las líneas con
 * importe mayor que 0, igual que hace el informe en sus dos modos.
 *
 * Los importes se acumulan en crudo y se redondean **una sola vez** al final:
 * redondear en cada suma arrastra medio céntimo por línea y con suficientes
 * líneas el documento acabaría separándose del informe sin ningún motivo real.
 *
 * @param {object[]} lineas
 * @param {Map<string, number|null>} ivaPorProducto
 * @param {{ campoImporte: string, motivoIva: string, motivoSinLineas: string }} politica
 */
export function importesPorIva(lineas, ivaPorProducto, politica) {
  const { campoImporte, motivoIva, motivoSinLineas } = politica;
  const porIva = new Map();
  const lineasFacturables = [];
  let sinRedondear = 0;
  let lineasContadas = 0;
  let lineasIgnoradas = 0;
  let desdeMaestro = 0;
  for (const l of lineas) {
    const importe = Number(l?.[campoImporte]);
    // Un importe negativo no es una línea sin importe: es un dato que no debería
    // existir. El sentido de un movimiento lo lleva el `Tipo` del pedido
    // (`Devolucion`), no el signo de sus líneas. Ignorarla —que es lo que se hacía—
    // factura al local menos mercancía de la que recibió, y nadie lo ve. Se excluye
    // el pedido entero y se explica, igual que con un IVA indeterminable.
    if (Number.isFinite(importe) && importe < 0) {
      return {
        ok: false,
        motivo: 'linea_importe_negativo',
        detalle:
          `Línea ${l?.LineaIndex ?? '?'} · ${String(l?.ProductoNombre ?? l?.ProductId ?? 'sin producto')}` +
          ` tiene ${campoImporte} negativo (${importe}). Corrige la línea del pedido antes de facturarlo.`,
      };
    }
    if (!Number.isFinite(importe) || importe <= 0) {
      lineasIgnoradas += 1;
      continue;
    }
    const tipoIva = tipoIvaDeLinea(l, ivaPorProducto);
    if (tipoIva == null) {
      return {
        ok: false,
        motivo: motivoIva,
        detalle: `Línea ${l?.LineaIndex ?? '?'} · ${String(l?.ProductoNombre ?? l?.ProductId ?? 'sin producto')}`,
      };
    }
    if (ivaVieneDelMaestro(l)) desdeMaestro += 1;
    porIva.set(tipoIva, (porIva.get(tipoIva) ?? 0) + importe);
    sinRedondear += importe;
    lineasContadas += 1;
    lineasFacturables.push({
      linea_index: l?.LineaIndex,
      product_id: String(l?.ProductId ?? '').trim(),
      producto_nombre: String(l?.ProductoNombre ?? '').trim(),
      cantidad: Number(l?.Cantidad) || 0,
      importe,
      tipo_iva: tipoIva,
    });
  }
  if (lineasContadas === 0) {
    return { ok: false, motivo: motivoSinLineas };
  }
  return {
    ok: true,
    porIva,
    lineas_facturables: lineasFacturables,
    sin_redondear: sinRedondear,
    lineas_contadas: lineasContadas,
    lineas_ignoradas: lineasIgnoradas,
    lineas_iva_desde_producto: desdeMaestro,
  };
}

/**
 * Líneas fiscales del documento: una por cada línea de pedido facturable, con la
 * cantidad real del albarán y el precio unitario que reproduce el importe del
 * pedido (con el signo que corresponda en abonos).
 *
 * El orden sigue el de los pedidos en el grupo (origen, fecha, id) y, dentro de
 * cada pedido, el índice de línea del albarán.
 */
export function lineasDocumentoDePedidos(pedidos) {
  const lineas = [];
  for (const p of pedidos) {
    const signo = p.signo ?? 1;
    const pedidoId = String(p.Id ?? '').trim();
    const local = String(p.local_nombre || '').trim();
    for (const lf of p.lineas_facturables ?? []) {
      const importe = Number(lf.importe);
      if (!Number.isFinite(importe) || importe <= 0) continue;
      const cantidadRaw = Number(lf.cantidad);
      const cantidad = Number.isFinite(cantidadRaw) && cantidadRaw > 0 ? cantidadRaw : 1;
      const importeSigned = round2(signo * importe);
      const precioUnitario = round2(importeSigned / cantidad);
      const producto = String(lf.producto_nombre || lf.product_id || 'Producto').trim();
      const partes = [producto];
      if (pedidoId) partes.push(`pedido ${pedidoId}`);
      if (local) partes.push(local);
      lineas.push({
        descripcion: partes.join(' · '),
        cantidad,
        precio_unitario: precioUnitario,
        tipo_iva: lf.tipo_iva,
        descuento_pct: 0,
        retencion_pct: 0,
        _orden: `${String(p.origen_nombre)}#${String(p.fecha)}#${pedidoId}#${String(lf.linea_index ?? 0).padStart(4, '0')}`,
      });
    }
  }
  lineas.sort((a, b) => String(a._orden).localeCompare(String(b._orden)));
  return lineas.map(({ _orden, ...rest }) => rest);
}

// ─── Desgloses del informe ───

// ─── Planificación compartida ───

/**
 * Calcula qué documentos se emitirían de los pedidos de un periodo, sin escribir
 * nada. Es el cuerpo común de la venta de mercancía y del abono de rappel.
 *
 * Lo que aporta cada dominio en `politica`:
 * - `campoImporte`: `TotalLinea` (venta) o `TotalRappel` (abono).
 * - `motivoIva` / `motivoSinLineas`: sus textos de exclusión.
 * - `excluirDevoluciones`: la venta no factura una devolución (haría falta una
 *   rectificativa); el abono sí la necesita, porque anula el rappel que generó
 *   la compra original.
 * - `construirDocumento(datosGrupo)`: devuelve el constructor de su documento.
 *
 * `cerrables` va siempre vacío: aquí no hay nada que cerrar, porque la ventana de
 * selección es el propio periodo y un pedido no facturable no reaparece mes tras
 * mes.
 */
export async function planificarDocumentos({ periodo, ajustes, contexto, politica }) {
  const {
    localesPorId,
    localesPorAlmacen,
    localesAproximadosPorAlmacen,
    almacenesPorId,
    empresasPorId,
    ivaPorProducto,
  } = contexto;
  const { candidatos, anteriores } = await buscarPedidosCandidatos(periodo, politica.campoMarca);

  const excluidos = [];
  const grupos = new Map();
  const noFacturables = { devoluciones: 0, misma_sociedad: 0, sin_importe: 0 };
  let lineasIgnoradas = 0;
  let lineasIvaDesdeProducto = 0;

  const excluir = (motivo, datos = {}, detalle = '') => {
    excluidos.push({
      motivo,
      motivo_texto: politica.motivos[motivo] || MOTIVOS_COMUNES[motivo] || motivo,
      ...(detalle && { detalle }),
      ...datos,
    });
  };

  for (const pedido of candidatos) {
    const referencia = {
      pedido_id: String(pedido.Id ?? ''),
      fecha: pedido.fecha_referencia,
      local_id: String(pedido.LocalId ?? '').trim(),
      local_nombre: localesPorId.get(String(pedido.LocalId ?? '').trim())?.nombre || '',
      pedidos: 1,
    };

    const emisora = resolverEmisora(pedido, {
      idEmpresaAlmacenGeneral: ajustes.id_empresa_almacen_general,
      almacenesPorId,
      localesPorAlmacen,
      localesAproximadosPorAlmacen,
    });
    if (!emisora.ok) {
      excluir(emisora.motivo, { ambito: 'pedido', ...referencia }, emisora.detalle);
      continue;
    }
    const receptora = resolverReceptora(pedido, { localesPorId });
    if (!receptora.ok) {
      excluir(receptora.motivo, { ambito: 'pedido', ...referencia }, receptora.detalle);
      continue;
    }

    const esDevolucion = String(pedido.Tipo ?? '').trim() === TIPO_DEVOLUCION;
    if (esDevolucion && politica.excluirDevoluciones) {
      noFacturables.devoluciones += 1;
      excluir('devolucion', {
        ambito: 'pedido',
        ...referencia,
        id_empresa_emisora: emisora.id_empresa,
        id_empresa: receptora.id_empresa,
      });
      continue;
    }
    // Movimiento entre almacenes de la misma sociedad: operativa normal que no
    // genera documento. No se informa pedido a pedido para no llenar el informe
    // de ruido; va en el contador.
    if (emisora.id_empresa === receptora.id_empresa) {
      noFacturables.misma_sociedad += 1;
      continue;
    }

    const importes = importesPorIva(await buscarLineasPedido(pedido.Id), ivaPorProducto, politica);
    if (!importes.ok) {
      // Un pedido sin nada que facturar en **este** flujo no es una anomalía: la
      // mayoría de los pedidos no llevan rappel. Se cuenta, no se denuncia.
      if (importes.motivo === politica.motivoSinLineas && politica.sinImporteEsNormal) {
        noFacturables.sin_importe += 1;
        continue;
      }
      excluir(
        importes.motivo,
        {
          ambito: 'pedido',
          ...referencia,
          id_empresa_emisora: emisora.id_empresa,
          id_empresa: receptora.id_empresa,
        },
        importes.detalle
      );
      continue;
    }
    lineasIgnoradas += importes.lineas_ignoradas;
    lineasIvaDesdeProducto += importes.lineas_iva_desde_producto;

    const clave = claveGrupo(emisora.id_empresa, receptora.id_empresa);
    let grupo = grupos.get(clave);
    if (!grupo) {
      grupo = {
        clave,
        id_empresa_emisora: emisora.id_empresa,
        id_empresa: receptora.id_empresa,
        pedidos: [],
      };
      grupos.set(clave, grupo);
    }
    grupo.pedidos.push({
      // Lo que necesita el reclamo para condicionar la escritura. Los campos que
      // definen la factura se copian tal cual, sin normalizar ni poner por
      // defecto: la condición tiene que comparar contra lo que hay en la tabla,
      // y un `undefined` aquí significa "el atributo no estaba" (ver
      // `CAMPOS_QUE_DEFINEN_LA_FACTURA`).
      Id: String(pedido.Id ?? ''),
      Estado: pedido.Estado,
      CompletadoEn: pedido.CompletadoEn,
      Fecha: pedido.Fecha,
      lineas_rev: pedido.lineas_rev,
      LocalId: pedido.LocalId,
      AlmacenOrigenId: pedido.AlmacenOrigenId,
      factura_id_empresa_local: pedido.factura_id_empresa_local,
      Tipo: pedido.Tipo,
      // Lo que necesitan el documento y el informe.
      fecha: pedido.fecha_referencia,
      tipo: esDevolucion ? TIPO_DEVOLUCION : 'Pedido',
      // Signo con el que este pedido entra en el documento. Los importes de
      // `porIva` son siempre magnitudes positivas.
      signo: politica.signoDe ? politica.signoDe(pedido, esDevolucion) : 1,
      local_id: receptora.local_id,
      local_nombre: receptora.local_nombre,
      empresa_local_congelada: receptora.congelada,
      origen_clave: emisora.origen_clave,
      origen_nombre: emisora.origen_nombre,
      porIva: importes.porIva,
      lineas_facturables: importes.lineas_facturables,
      base_sin_redondear: importes.sin_redondear,
      num_lineas: importes.lineas_contadas,
    });
  }

  const documentos = [];
  for (const grupo of grupos.values()) {
    const emisoraFiscal = fiscalDeSociedad(grupo.id_empresa_emisora, empresasPorId, { emisora: true });
    if (!emisoraFiscal.ok) {
      excluir(
        emisoraFiscal.motivo,
        {
          ambito: 'sociedad',
          id_empresa_emisora: grupo.id_empresa_emisora,
          empresa_emisora_nombre: emisoraFiscal.nombre ?? '',
          id_empresa: grupo.id_empresa,
          pedidos: grupo.pedidos.length,
        },
        emisoraFiscal.detalle
      );
      continue;
    }
    const receptoraFiscal = fiscalDeSociedad(grupo.id_empresa, empresasPorId);
    if (!receptoraFiscal.ok) {
      excluir(
        receptoraFiscal.motivo,
        {
          ambito: 'sociedad',
          id_empresa_emisora: grupo.id_empresa_emisora,
          id_empresa: grupo.id_empresa,
          empresa_nombre: receptoraFiscal.nombre ?? '',
          pedidos: grupo.pedidos.length,
        },
        receptoraFiscal.detalle
      );
      continue;
    }

    // Líneas agrupadas por local de origen y, dentro, por fecha del pedido.
    grupo.pedidos.sort(
      (a, b) =>
        String(a.origen_nombre).localeCompare(String(b.origen_nombre)) ||
        String(a.fecha).localeCompare(String(b.fecha)) ||
        String(a.Id).localeCompare(String(b.Id))
    );

    /**
     * Constructor del documento del par a partir de los pedidos que realmente se
     * hayan podido reclamar. **Único** constructor: lo usan la previsualización
     * con todos los pedidos y la generación con los reclamados, para que no
     * puedan divergir en los datos fiscales de la cabecera.
     */
    const construir = politica.construirDocumento({
      emisora: emisoraFiscal.fiscal,
      receptora: receptoraFiscal.fiscal,
      periodo,
      ajustes,
    });

    const { factura, lineas } = construir(grupo.pedidos);
    const identidad = {
      ambito: 'sociedad',
      id_empresa_emisora: grupo.id_empresa_emisora,
      empresa_emisora_nombre: emisoraFiscal.fiscal.nombre,
      id_empresa: grupo.id_empresa,
      empresa_nombre: receptoraFiscal.fiscal.nombre,
      pedidos: grupo.pedidos.length,
    };
    if (factura.total_factura === 0) {
      excluir('factura_total_cero', identidad);
      continue;
    }
    const erroresEmision = politica.validar(factura, lineas);
    if (erroresEmision.length > 0) {
      excluir('validacion_emision', identidad, erroresEmision.join(' · '));
      continue;
    }

    // La suma de las líneas de pedido sin redondear es lo que da el informe. Un
    // descuadre de céntimos no bloquea, pero se informa: el informe suma en crudo
    // y el documento redondea cada línea fiscal.
    const baseInforme = baseSegunInforme(grupo.pedidos);
    const descuadre = round2(factura.base_imponible - baseInforme);

    documentos.push({
      ...identidad,
      empresa_cif: receptoraFiscal.fiscal.cif,
      empresa_emisora_cif: emisoraFiscal.fiscal.cif,
      emisora_fiscal: emisoraFiscal.fiscal,
      receptora_fiscal: receptoraFiscal.fiscal,
      num_pedidos: grupo.pedidos.length,
      base: factura.base_imponible,
      iva: factura.total_iva,
      total: factura.total_factura,
      base_informe: baseInforme,
      descuadre_centimos: descuadre === 0 ? 0 : Math.round(descuadre * 100),
      impuestos: desgloseImpuestos(lineas),
      origenes: desgloseOrigenes(grupo.pedidos),
      locales: desgloseLocalesDestino(grupo.pedidos),
      // Lo que consume la mecánica de generación.
      elementos: grupo.pedidos,
      construir,
    });
  }

  documentos.sort(
    (a, b) =>
      String(a.empresa_emisora_nombre).localeCompare(String(b.empresa_emisora_nombre)) ||
      String(a.empresa_nombre).localeCompare(String(b.empresa_nombre))
  );

  return {
    ok: true,
    periodo,
    inicio: inicioSeleccion(periodo),
    corte: cortePedidos(periodo),
    facturas: documentos,
    grupos: documentos,
    excluidos,
    cerrables: [],
    candidatos: candidatos.length,
    no_facturables: noFacturables,
    pendientes_periodos_anteriores: anteriores,
    lineas_sin_importe: lineasIgnoradas,
    lineas_iva_desde_producto: lineasIvaDesdeProducto,
  };
}

/**
 * Base del documento tal como la sumaría el informe: en crudo, con el signo de
 * cada pedido y redondeada una sola vez al final.
 */
export function baseSegunInforme(pedidos) {
  return round2(pedidos.reduce((s, p) => s + (p.signo ?? 1) * p.base_sin_redondear, 0));
}

/** Importe con el que un pedido entra en el documento, ya con su signo. */
function importePedido(pedido) {
  let total = 0;
  for (const importe of pedido.porIva.values()) total += importe;
  return (pedido.signo ?? 1) * total;
}

/** Cuota por tipo de IVA, como la espera el desglose de una factura. */
export function desgloseImpuestos(lineas) {
  const porTipo = new Map();
  for (const l of lineas) {
    const tipo = Number(l.tipo_iva);
    const acc = porTipo.get(tipo) || { tipo_iva: tipo, base: 0, cuota: 0 };
    acc.base = round2(acc.base + Number(l.base_linea ?? 0));
    acc.cuota = round2(acc.cuota + Number(l.iva_linea ?? 0));
    porTipo.set(tipo, acc);
  }
  return [...porTipo.values()].sort((a, b) => a.tipo_iva - b.tipo_iva);
}

/** Desglose por local de origen, que es como se agrupan las líneas. */
export function desgloseOrigenes(pedidos) {
  const porOrigen = new Map();
  for (const p of pedidos) {
    const grupo = porOrigen.get(p.origen_clave) || {
      origen_clave: p.origen_clave,
      origen_nombre: p.origen_nombre,
      num_pedidos: 0,
      base: 0,
    };
    grupo.num_pedidos += 1;
    grupo.base += importePedido(p);
    porOrigen.set(p.origen_clave, grupo);
  }
  return [...porOrigen.values()]
    .map((g) => ({ ...g, base: round2(g.base) }))
    .sort((a, b) => a.origen_nombre.localeCompare(b.origen_nombre));
}

/**
 * Desglose por local que recibe. No decide las líneas del documento, pero sin él
 * el receptor no sabría a qué local imputar el gasto.
 */
export function desgloseLocalesDestino(pedidos) {
  const porLocal = new Map();
  for (const p of pedidos) {
    const grupo = porLocal.get(p.local_id) || {
      local_id: p.local_id,
      local_nombre: p.local_nombre || p.local_id,
      base: 0,
      pedidos: [],
    };
    const basePedido = importePedido(p);
    grupo.base += basePedido;
    grupo.pedidos.push({
      id: p.Id,
      fecha: p.fecha,
      fecha_texto: fechaCorta(p.fecha),
      origen_nombre: p.origen_nombre,
      lineas: p.num_lineas,
      base: round2(basePedido),
      ...(p.tipo === TIPO_DEVOLUCION && { tipo: TIPO_DEVOLUCION }),
    });
    porLocal.set(p.local_id, grupo);
  }
  return [...porLocal.values()]
    .map((g) => ({ ...g, base: round2(g.base) }))
    .sort((a, b) => a.local_nombre.localeCompare(b.local_nombre));
}
