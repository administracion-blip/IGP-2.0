/**
 * Paginación de las consultas del módulo de dirección.
 *
 * El cursor es la `LastEvaluatedKey` de DynamoDB en base64, el mismo formato que
 * usa `api/lib/banca/store.js`. Se reimplementa aquí en lugar de importarlo de
 * banca para no acoplar dos dominios por doce líneas: traer ese módulo arrastraría
 * sus clientes y sus nombres de tabla.
 *
 * Por qué un cursor opaco y no un número de página: DynamoDB no sabe saltar a la
 * página 7. Exponer `?pagina=7` obligaría a leer las seis anteriores y tirarlas.
 */

/** @param {Record<string, any>|null|undefined} lastKey */
export function codificarCursor(lastKey) {
  if (!lastKey) return null;
  return Buffer.from(JSON.stringify(lastKey), 'utf8').toString('base64');
}

/**
 * Un cursor ilegible devuelve `null` en lugar de lanzar: el efecto es empezar por
 * el principio, que es preferible a un `500` por un parámetro manipulado.
 */
export function decodificarCursor(cursor) {
  const raw = String(cursor || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Tamaño de página saneado. Un `limite` ausente, cero, negativo o absurdo cae al
 * valor por defecto en lugar de rechazarse: es un parámetro de comodidad, no una
 * regla de negocio.
 */
export function limiteValido(valor, { porDefecto = 50, maximo = 200 } = {}) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 1) return porDefecto;
  return Math.min(Math.floor(n), maximo);
}
