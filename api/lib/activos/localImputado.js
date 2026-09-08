/**
 * Local imputado: el local al que se factura la prenda entregada, que puede
 * ser distinto del almacén del que sale. Las filas antiguas no lo llevan: en
 * ese caso se imputa a su propio local.
 */

function texto(v) {
  return v == null ? '' : String(v).trim();
}

export function localImputadoDe(item) {
  return texto(item?.local_imputado_id) || texto(item?.id_local);
}

export function nombreLocalImputadoDe(item) {
  return texto(item?.local_imputado_nombre) || texto(item?.local_nombre);
}

/**
 * Dos lotes solo se pueden fusionar si imputan al mismo local: si no, después
 * no se podría separar la factura de cada uno.
 */
export function mismoLocalImputado(item, localImputadoId) {
  return localImputadoDe(item) === texto(localImputadoId);
}
