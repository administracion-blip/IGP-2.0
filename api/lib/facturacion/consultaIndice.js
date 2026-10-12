/**
 * Lecturas por GSI de facturas, pagos y remesas (S-18).
 *
 * No hay vuelta a Scan: si el ítem no está en el índice (le falta la clave o
 * no entra en el rango), no sale. Los valores de clave son los de
 * `clavesIndice.js` (`gsi_tipo`, `gsi_fecha`, `PAGO`, `REMESA`, `ACTIVA`, …).
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';

export const INDICE_TIPO_FECHA = 'Tipo-Fecha-index';
export const INDICE_ESTADO_FECHA = 'Estado-Fecha-index';
export const INDICE_PROVEEDOR_FECHA = 'Proveedor-Fecha-index';
export const INDICE_EMISOR_FECHA = 'Emisor-Fecha-index';
export const INDICE_SERIE_FECHA = 'Serie-Fecha-index';
export const INDICE_PERIODO = 'Periodo-index';
export const INDICE_LISTADO_FECHA = 'Listado-Fecha-index';
export const INDICE_ACTIVA = 'Activa-index';

/**
 * Recorre un GSI paginando por `LastEvaluatedKey`.
 *
 * `desde`+`hasta` → BETWEEN inclusive. Solo `hasta` → `<=`. `prefijo` →
 * `begins_with` de la sort key. Sin sort, solo la partición.
 */
export async function consultarIndice({ tabla, indice, hash, hashValor, sort, desde, hasta, prefijo }) {
  if (hashValor == null || String(hashValor) === '') return [];
  const names = { '#h': hash };
  const values = { ':h': hashValor };
  let condicion = '#h = :h';
  if (prefijo != null && prefijo !== '') {
    names['#s'] = sort;
    values[':prefijo'] = prefijo;
    condicion += ' AND begins_with(#s, :prefijo)';
  } else if (desde != null && hasta != null) {
    names['#s'] = sort;
    values[':desde'] = desde;
    values[':hasta'] = hasta;
    condicion += ' AND #s BETWEEN :desde AND :hasta';
  } else if (hasta != null) {
    names['#s'] = sort;
    values[':hasta'] = hasta;
    condicion += ' AND #s <= :hasta';
  } else if (desde != null) {
    names['#s'] = sort;
    values[':desde'] = desde;
    condicion += ' AND #s >= :desde';
  }
  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(new QueryCommand({
      TableName: tabla,
      IndexName: indice,
      KeyConditionExpression: condicion,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

export function facturasPorTipo(tipo, desde, hasta) {
  return consultarIndice({
    tabla: tables.facturas,
    indice: INDICE_TIPO_FECHA,
    hash: 'gsi_tipo',
    hashValor: tipo,
    sort: 'gsi_fecha',
    desde,
    hasta,
  });
}

export function facturasPorEstado(estado, { desde, hasta, prefijo } = {}) {
  return consultarIndice({
    tabla: tables.facturas,
    indice: INDICE_ESTADO_FECHA,
    hash: 'gsi_estado',
    hashValor: estado,
    sort: 'gsi_fecha',
    desde,
    hasta,
    prefijo,
  });
}

export function facturasPorProveedor(cif, { desde, hasta, prefijo } = {}) {
  return consultarIndice({
    tabla: tables.facturas,
    indice: INDICE_PROVEEDOR_FECHA,
    hash: 'gsi_proveedor',
    hashValor: cif,
    sort: 'gsi_fecha',
    desde,
    hasta,
    prefijo,
  });
}

export function facturasPorEmisor(emisor, { desde, hasta, prefijo } = {}) {
  return consultarIndice({
    tabla: tables.facturas,
    indice: INDICE_EMISOR_FECHA,
    hash: 'gsi_emisor',
    hashValor: emisor,
    sort: 'gsi_fecha',
    desde,
    hasta,
    prefijo,
  });
}

export function facturasPorPeriodo(gsiPeriodo) {
  return consultarIndice({
    tabla: tables.facturas,
    indice: INDICE_PERIODO,
    hash: 'gsi_periodo',
    hashValor: gsiPeriodo,
  });
}

export function pagosPorListado({ desde, hasta } = {}) {
  return consultarIndice({
    tabla: tables.facturasPagos,
    indice: INDICE_LISTADO_FECHA,
    hash: 'gsi_listado',
    hashValor: 'PAGO',
    sort: 'gsi_fecha',
    desde,
    hasta,
  });
}

export function remesasPorListado({ desde, hasta } = {}) {
  return consultarIndice({
    tabla: tables.remesas,
    indice: INDICE_LISTADO_FECHA,
    hash: 'gsi_listado',
    hashValor: 'REMESA',
    sort: 'gsi_fecha',
    desde,
    hasta,
  });
}

export function remesasActivas() {
  return consultarIndice({
    tabla: tables.remesas,
    indice: INDICE_ACTIVA,
    hash: 'gsi_activa',
    hashValor: 'ACTIVA',
  });
}
