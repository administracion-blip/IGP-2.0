/**
 * Marcas que las facturaciones periódicas dejan en la factura para saber qué
 * periodo liquidó, con qué ejecución y cuántos elementos entraron.
 *
 * Vive aparte de los routers porque quien las escribe (los tres generadores) y
 * quien las tiene que quitar (las copias de factura: duplicar y rectificar) están
 * en ficheros distintos, y el fallo es silencioso en los dos sentidos: una copia
 * que hereda `rappel_periodo` cuenta como "ya hay documento de este periodo entre
 * estas dos sociedades" en el aviso de la previsualización mensual, y un campo
 * nuevo que un generador escriba sin apuntarlo aquí volvería a colarse en las
 * copias sin que nada avise.
 */

/** Prefijos de los tres dominios que facturan por periodos. */
const DOMINIOS = ['mantenimiento', 'ventas_internas', 'rappel'];

/** Sufijos que escribe `construirDocumento` de cada dominio. */
const SUFIJOS = ['periodo', 'origen', 'ejecucion', 'partes', 'pedidos'];

/**
 * Campos de marca de los tres dominios. Se generan combinando prefijos y sufijos
 * en vez de listarlos a mano: así un dominio que añada un sufijo lo añade para
 * todos y no hay forma de escribir mal uno de los doce nombres.
 *
 * Sobran combinaciones (`mantenimiento_pedidos` no existe, `rappel_partes`
 * tampoco), y da igual: borrar un campo que no está no hace nada.
 */
export const CAMPOS_MARCA_FACTURACION_PERIODICA = DOMINIOS.flatMap((dominio) =>
  SUFIJOS.map((sufijo) => `${dominio}_${sufijo}`)
);

/**
 * Quita de una copia de factura las marcas de la facturación periódica: la copia
 * no ha liquidado ningún periodo.
 * @param {object} factura se modifica en el sitio
 */
export function limpiarMarcasFacturacionPeriodica(factura) {
  for (const campo of CAMPOS_MARCA_FACTURACION_PERIODICA) {
    delete factura[campo];
  }
}
