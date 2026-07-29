import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables, keyForFacturaPrincipalId } from '../db.js';
import { queryLineasByFactura } from '../dynamo/facturasRelacionadas.js';
import { reservarNumeroSerie, existeCorrelativoDuplicado } from './series.js';
import crypto from 'crypto';

/** Reintentos de reserva cuando el correlativo obtenido ya está ocupado. */
const MAX_INTENTOS_NUMERO = 4;

function now() {
  return new Date().toISOString();
}

function computeHash(factura) {
  const payload = JSON.stringify({
    id: factura.id_factura,
    serie: factura.serie,
    numero: factura.numero,
    tipo: factura.tipo,
    empresa_cif: factura.empresa_cif,
    fecha_emision: factura.fecha_emision,
    base_imponible: factura.base_imponible,
    total_iva: factura.total_iva,
    total_factura: factura.total_factura,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function registrarAuditoria(id_factura, accion, usuario_id, usuario_nombre, detalle) {
  const id_entrada = `AUD-${id_factura}-${Date.now()}`;
  await docClient.send(
    new PutCommand({
      TableName: tables.facturasAuditoria,
      Item: {
        id_entrada,
        id_factura,
        timestamp_accion: now(),
        accion,
        usuario_id: usuario_id || '',
        usuario_nombre: usuario_nombre || '',
        detalle: typeof detalle === 'string' ? detalle : JSON.stringify(detalle || {}),
      },
    }),
  );
}

/**
 * Reserva un correlativo libre para una factura de venta. Si la red de seguridad
 * detecta que el número reservado ya está ocupado (numeración antigua desalineada
 * del contador), reintenta: cada reserva avanza el contador, así que unos pocos
 * intentos bastan para superar el tramo ocupado.
 * @returns {Promise<{ ok: true, numero: number, numero_factura: string } | { ok: false, status: number, error: string }>}
 */
async function reservarCorrelativoVenta(factura) {
  let ultimoIntentado = '';
  for (let intento = 1; intento <= MAX_INTENTOS_NUMERO; intento++) {
    let reserva;
    try {
      // La factura lleva su sociedad emisora: el correlativo es por serie, año
      // y emisor, así que la reserva la necesita.
      reserva = await reservarNumeroSerie(factura.serie, factura.fecha_emision, factura);
      if (!reserva) {
        return { ok: false, status: 404, error: `Serie "${factura.serie}" no encontrada` };
      }
      if (!(await existeCorrelativoDuplicado(reserva, factura.id_factura))) {
        return { ok: true, numero: reserva.numero, numero_factura: reserva.numero_factura };
      }
    } catch (err) {
      console.error('[emitir factura] reserva de número:', factura.id_factura, factura.serie, err);
      return { ok: false, status: 500, error: 'No se pudo asignar el número de factura. La factura sigue en borrador.' };
    }
    ultimoIntentado = reserva.numero_factura;
    console.warn(
      `[emitir factura] correlativo ${ultimoIntentado} ya ocupado, reintento ${intento}/${MAX_INTENTOS_NUMERO}`,
    );
  }
  return {
    ok: false,
    status: 409,
    error: `No se ha podido asignar un número libre en la serie "${factura.serie}" tras ${MAX_INTENTOS_NUMERO} intentos (último probado: ${ultimoIntentado}). Revise la numeración de la serie.`,
  };
}

/**
 * ¿Es un documento que devuelve importe, y por tanto puede ir en negativo?
 *
 * Dos señales, y las dos las pone el propio documento:
 *
 * - `es_abono`: la marca explícita. La ponen los abonos de rappel generados por
 *   `facturarRappel.js` y puede ponerla el alta manual (es campo editable de
 *   `PUT /facturacion/facturas/:id`).
 * - `es_rectificativa`: lo que crea `POST /facturacion/facturas/:id/rectificar`.
 *   Una rectificativa en negativo es, por definición, un abono: corrige a la baja
 *   una factura ya emitida. Exigirle además la marca de abono habría dejado sin
 *   emitir el camino de rectificar, que es el que existía antes de que hubiera
 *   generador de abonos y que ninguna pantalla sabe marcar.
 *
 * Lo que esto **no** relaja es la protección de una venta ordinaria: sin ninguna
 * de las dos señales, un total negativo sigue siendo un error de cálculo y se
 * rechaza. Ese era el agujero original —cualquier venta mal sumada se emitía en
 * negativo con su número fiscal y su huella VERI*FACTU— y sigue tapado.
 *
 * En los gastos (`IN`) el signo no se comprueba: el documento lo emite un tercero
 * y los abonos de proveedor entran en negativo por la revisión de OCR. Ahí el
 * signo es un dato del proveedor, no una decisión nuestra.
 */
export function esDocumentoDeAbono(factura) {
  return factura?.es_abono === true || factura?.es_rectificativa === true;
}

/**
 * Valida si una factura puede emitirse o validarse (revisión OCR).
 * @returns {string[]} lista de errores (vacía = OK)
 */
export function validarDatosEmision(factura, lineas) {
  const errores = [];
  if (factura.tipo === 'IN') {
    if (!factura.emisor_nombre && !factura.emisor_cif) {
      errores.push('Datos de la empresa del grupo (ordenante) son obligatorios');
    }
    if (!factura.empresa_nombre && !factura.empresa_cif) {
      errores.push('Datos del proveedor (nombre o CIF) son obligatorios');
    }
  } else {
    if (!factura.empresa_nombre && !factura.empresa_cif) errores.push('Datos de empresa (nombre o CIF) obligatorios');
    if (!factura.empresa_cif) errores.push('CIF/NIF del cliente es obligatorio para facturas de venta');
  }
  if (!factura.fecha_emision) errores.push('La fecha de emisión es obligatoria');
  if (factura.tipo === 'OUT' && !factura.serie) errores.push('La serie es obligatoria');

  const total = Number(factura.total_factura) || 0;
  const esAbono = esDocumentoDeAbono(factura);
  if (total === 0) {
    errores.push(esAbono ? 'El abono no puede tener importe 0' : 'La factura no puede tener importe 0');
  } else if (factura.tipo === 'OUT') {
    if (factura.es_abono === true && total > 0) {
      errores.push('Un abono debe tener importe negativo: con importe positivo estaría cobrando en vez de abonando');
    }
    if (!esAbono && total < 0) {
      errores.push(
        'Una factura de venta no puede tener importe negativo. Para devolver importes, márcala como abono' +
          ' o emítela como rectificativa de la factura que corrige.'
      );
    }
  }

  if (factura.tipo === 'OUT' && lineas.length === 0) errores.push('La factura debe tener al menos una línea');

  for (const l of lineas) {
    if (!l.descripcion) errores.push(`Línea ${l.id_linea}: falta descripción`);
    if ((l.cantidad || 0) <= 0) errores.push(`Línea ${l.id_linea}: cantidad debe ser mayor que 0`);
  }
  return errores;
}

/**
 * Emite o valida revisión de una factura por id.
 * @returns {Promise<{ ok: true, factura, esValidacionRevision } | { ok: false, status: number, error?: string, errores?: string[] }>}
 */
export async function emitirOValidarFacturaPorId(id, { usuario_id = '', usuario_nombre = '', soloRevision = false } = {}) {
  const existing = await docClient.send(
    new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }),
  );
  if (!existing.Item) {
    return { ok: false, status: 404, error: 'Factura no encontrada' };
  }
  const factura = { ...existing.Item };
  const estadoPrevio = factura.estado;

  const esValidacionRevision = factura.tipo === 'IN' && factura.estado === 'pendiente_revision';

  if (soloRevision) {
    if (!esValidacionRevision) {
      return {
        ok: false,
        status: 400,
        error: 'Solo se pueden validar facturas de gasto en pendiente de revisión',
      };
    }
  } else {
    const puedeEmitir = factura.estado === 'borrador' || esValidacionRevision;
    if (!puedeEmitir) {
      return {
        ok: false,
        status: 400,
        error: factura.tipo === 'IN'
          ? 'Solo se pueden emitir facturas en borrador o validar las pendientes de revisión'
          : 'Solo se pueden emitir facturas en borrador',
      };
    }
  }

  const lineas = await queryLineasByFactura(id);
  const errores = validarDatosEmision(factura, lineas);
  if (errores.length > 0) {
    return { ok: false, status: 400, error: 'Validación fiscal fallida', errores };
  }

  // Las facturas de venta nacen sin número: el correlativo se reserva aquí para
  // que un borrador borrado no deje huecos en la numeración fiscal. Debe ir
  // antes del hash VERI*FACTU, que incluye `numero`.
  let numeroReservadoAhora = '';
  if (!esValidacionRevision && factura.tipo === 'OUT' && !factura.numero) {
    const reserva = await reservarCorrelativoVenta(factura);
    if (!reserva.ok) return reserva;
    factura.numero = reserva.numero;
    factura.numero_factura = reserva.numero_factura;
    numeroReservadoAhora = reserva.numero_factura;
  }

  factura.estado = 'emitida';
  if (factura.tipo === 'IN') factura.estado = 'pendiente_pago';

  if (!factura.fecha_vencimiento && factura.condiciones_pago) {
    const diasMap = { contado: 0, '15_dias': 15, '30_dias': 30, '60_dias': 60, '90_dias': 90 };
    const dias = diasMap[factura.condiciones_pago];
    if (dias != null) {
      const base = new Date(factura.fecha_emision || now().slice(0, 10));
      base.setDate(base.getDate() + dias);
      factura.fecha_vencimiento = base.toISOString().slice(0, 10);
    }
  }

  factura.modificado_por = usuario_id || '';
  factura.modificado_en = now();
  factura.version = (factura.version || 1) + 1;

  factura.verifactu_hash = computeHash(factura);
  factura.verifactu_registro_alta = JSON.stringify({
    id_factura: factura.id_factura,
    fecha_emision: factura.fecha_emision,
    hash: factura.verifactu_hash,
    timestamp: now(),
  });

  // Deja traza del número reservado antes de intentar guardarlo: si el Put falla
  // el correlativo ya está consumido (tablas distintas, sin transacción) y hay que
  // poder justificar el hueco. No se decrementa el contador: no es seguro con
  // concurrencia.
  if (numeroReservadoAhora) {
    console.info('[emitir factura] correlativo reservado', {
      id_factura: id,
      serie: factura.serie,
      numero: factura.numero,
      numero_factura: numeroReservadoAhora,
    });
  }

  try {
    await docClient.send(
      new PutCommand({
        TableName: tables.facturas,
        Item: factura,
        // La comprobación de estado se hizo sin bloqueo: si otra petición emitió
        // el mismo borrador entretanto, esta debe fallar en vez de pisarla.
        ConditionExpression: '#estado = :estadoPrevio',
        ExpressionAttributeNames: { '#estado': 'estado' },
        ExpressionAttributeValues: { ':estadoPrevio': estadoPrevio },
      }),
    );
  } catch (err) {
    const esConcurrencia = err?.name === 'ConditionalCheckFailedException';
    console.error(
      esConcurrencia
        ? '[emitir factura] emisión concurrente: correlativo reservado sin usar'
        : '[emitir factura] fallo al guardar: correlativo reservado sin usar',
      { id_factura: id, serie: factura.serie, numero: factura.numero, numero_factura: numeroReservadoAhora },
      err,
    );
    if (numeroReservadoAhora) {
      try {
        await registrarAuditoria(id, 'numero_reservado_no_usado', usuario_id, usuario_nombre, {
          serie: factura.serie,
          numero: factura.numero,
          numero_factura: numeroReservadoAhora,
          motivo: esConcurrencia ? 'emision_concurrente' : (err?.message || 'error_al_guardar'),
        });
      } catch (errAud) {
        console.error('[emitir factura] no se pudo auditar el correlativo sin usar:', errAud);
      }
    }
    if (esConcurrencia) {
      return {
        ok: false,
        status: 409,
        error: 'La factura ya ha sido emitida por otro usuario. Actualice la pantalla para ver su estado actual.',
      };
    }
    return { ok: false, status: 500, error: 'No se pudo guardar la factura emitida. Inténtelo de nuevo.' };
  }

  const accionAuditoria = esValidacionRevision ? 'validacion_revision' : 'emision';
  await registrarAuditoria(id, accionAuditoria, usuario_id, usuario_nombre, {
    estado: factura.estado,
    hash: factura.verifactu_hash,
    numero_factura: factura.numero_factura || '',
    estado_anterior: esValidacionRevision ? 'pendiente_revision' : 'borrador',
  });

  return { ok: true, factura, esValidacionRevision };
}
