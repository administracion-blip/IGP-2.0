/**
 * Comparación de textos entre un movimiento bancario y una factura.
 *
 * El movimiento llega ya normalizado por `normalizarConcepto` (mayúsculas, sin
 * acentos, sin el prefijo del tipo de operación) y con el NIF extraído aparte.
 * La factura no: sus nombres y números vienen tal cual los escribió alguien. Lo
 * que hace este módulo es llevar ambos lados a la misma forma antes de comparar.
 *
 * Todo es puro: ni Dynamo ni fechas de sistema.
 */

import { normalizeCif } from '../../empresaCif.js';
import { aMayusculasSinAcentos } from '../../n43/concepto.js';

/**
 * Formas societarias, partículas, operativa de extracto y genéricos comerciales.
 * No distinguen a un proveedor de otro: si cuentan como coincidencia, casan
 * entre sí todos los "SL", "DISTRIBUCION" o "TRANSFERENCIA" del mundo.
 */
const PALABRAS_IGNORADAS = new Set([
  // Formas societarias y partículas
  'SL', 'SLU', 'SLL', 'SLNE', 'SLP', 'SA', 'SAU', 'SAL', 'SC', 'SCP', 'SCA', 'SRL', 'CB', 'UTE',
  'SOCIEDAD', 'LIMITADA', 'ANONIMA', 'UNIPERSONAL', 'LABORAL', 'CIVIL', 'COMUNIDAD', 'BIENES',
  'DE', 'DEL', 'LA', 'LAS', 'EL', 'LOS', 'Y', 'E', 'EN', 'POR', 'PARA', 'CON', 'SUS',
  // Operativa del extracto (para que la "marca" del movimiento no sea TRANSFERENCIA)
  'TRANSFERENCIA', 'TRANSFERENCIAS', 'ADEUDO', 'ADEUDOS', 'RECIBO', 'RECIBOS',
  'PAGO', 'PAGOS', 'DOMICILIADO', 'DOMICILIACION', 'DOMICILIACIONES',
  'CUOTA', 'CUOTAS', 'FAVOR', 'ABONO', 'ABONOS', 'CARGO', 'CARGOS', 'SEPA',
  'ORDENANTE', 'BENEFICIARIO', 'REMESA', 'REMESAS', 'MENSUAL', 'MENSUALES',
  // Genéricos comerciales
  'DISTRIBUCION', 'DISTRIBUTION', 'DISTRIBUCIONES', 'DISTRIBUTIONS',
  'SERVICES', 'SERVICIOS', 'SERVICE', 'SERVICIO',
  'GROUP', 'GRUPO', 'HOLDING', 'BOOKING',
  'RESTAURANT', 'RESTAURANTE', 'RESTAURANTES',
  'COMERCIAL', 'COMERCIALES', 'INTERNATIONAL', 'INTERNACIONAL',
  'ESPANA', 'SPAIN', 'SOLUTIONS', 'SOLUCIONES',
  'COMPANY', 'COMPANIA', 'COMPANIAS', 'GLOBAL', 'FOOD', 'FOODS',
  'TRADING', 'INDUSTRIAL', 'INDUSTRIALES', 'LOGISTICA', 'LOGISTICS',
]);

/** Longitud mínima de una palabra del nombre para tenerla en cuenta. */
const MIN_TOKEN_NOMBRE = 4;

/** Si solo casa una palabra, tiene que ser larga: "BARS" no identifica a nadie. */
const MIN_TOKEN_NOMBRE_UNICO = 6;

/**
 * Los extractos truncan el nombre del contrario ("…COCTEMAT" por
 * "COCTEMATIAS SL"), así que un prefijo suficientemente largo también cuenta
 * en la comparación token↔token.
 */
const MIN_PREFIJO_NOMBRE = 8;

/** Longitud mínima de una referencia, para no casar por un "1" suelto. */
const MIN_REFERENCIA = 4;

/** Una referencia de solo dígitos ("2026") aparece en cualquier concepto. */
const MIN_REFERENCIA_NUMERICA = 6;

/** Un CIF/NIF español tiene 9 caracteres; por debajo de 8 no es un CIF. */
const MIN_CIF = 8;

/**
 * Conceptos que en los extractos reales no son facturas: cobros de TPV,
 * traspasos entre cuentas del grupo, comisiones y nóminas. Sin este filtro la
 * pantalla de conciliación se llena de movimientos que nadie va a emparejar.
 *
 * Se comparan como subcadena contra el texto normalizado del movimiento. La
 * lista es un valor por defecto: cada llamada puede sustituirla.
 */
export const PATRONES_EXCLUSION_POR_DEFECTO = [
  'COMERCIA GLOBAL PAYMENTS',
  'MANTENIMIENTO TPV',
  'LIQUIDACION TARJETA',
  'TRASPASO',
  'COMISION',
  'NOMINA',
  'SEGURIDAD SOCIAL',
];

/** Mayúsculas sin acentos y con los espacios colapsados. */
export function normalizarTexto(valor) {
  return aMayusculasSinAcentos(valor).replace(/\s+/g, ' ').trim();
}

/** Solo A–Z y 0–9: así "2026-F/40", "2026 F 40" y "2026F40" son la misma referencia. */
export function compactarReferencia(valor) {
  return aMayusculasSinAcentos(valor).replace(/[^A-Z0-9]/g, '');
}

/**
 * @typedef {object} TextosMovimiento
 * @property {string} plano Concepto y referencias con espacios (nombres y patrones).
 * @property {string} compacto Lo mismo sin separadores (números de factura y CIF).
 */

/**
 * Textos del movimiento donde buscar.
 *
 * Se incluye el `concepto` crudo además del normalizado porque
 * `normalizarConcepto` se come el prefijo de la operación, y justo ahí está la
 * palabra que delata el ruido: el concepto normalizado de un "TRASPASO A
 * CUENTA…" ya no contiene "TRASPASO".
 *
 * @param {Record<string, any>} movimiento
 * @returns {TextosMovimiento}
 */
export function textosMovimiento(movimiento) {
  const partes = [
    movimiento?.concepto,
    movimiento?.conceptoNormalizado,
    movimiento?.referencia1,
    movimiento?.referencia2,
    movimiento?.numeroDocumento,
  ].filter((p) => p != null && String(p).trim() !== '');
  const plano = normalizarTexto(partes.join(' '));
  return { plano, compacto: compactarReferencia(plano) };
}

/**
 * Referencias con las que una factura puede aparecer en un extracto: su número,
 * el del proveedor y la combinación serie+número (con y sin ceros de relleno,
 * porque el correlativo se guarda como entero).
 *
 * @param {Record<string, any>} factura
 * @returns {string[]}
 */
export function referenciasFactura(factura) {
  const crudas = [factura?.numero_factura, factura?.numero_factura_proveedor];
  const serie = compactarReferencia(factura?.serie);
  const numero = Number(factura?.numero);
  if (serie && Number.isFinite(numero) && numero > 0) {
    crudas.push(`${serie}${numero}`);
    crudas.push(`${serie}${String(numero).padStart(6, '0')}`);
  }

  const salida = new Set();
  for (const cruda of crudas) {
    const ref = compactarReferencia(cruda);
    if (ref.length < MIN_REFERENCIA) continue;
    if (/^\d+$/.test(ref) && ref.length < MIN_REFERENCIA_NUMERICA) continue;
    salida.add(ref);
  }
  return [...salida];
}

/**
 * Primera referencia de la factura que aparece en el movimiento, o ''.
 * @param {string[]} referencias
 * @param {TextosMovimiento} textos
 * @returns {string}
 */
export function referenciaCoincidente(referencias, textos) {
  const compacto = textos?.compacto || '';
  if (!compacto) return '';
  for (const ref of referencias || []) {
    if (ref && compacto.includes(ref)) return ref;
  }
  return '';
}

/**
 * Palabras significativas de un nombre o de un concepto de extracto.
 * Descarta formas societarias, operativa bancaria y genéricos comerciales.
 */
export function tokensNombre(nombre) {
  return normalizarTexto(nombre)
    .split(/[^A-Z0-9Ñ]+/)
    .filter((t) => t.length >= MIN_TOKEN_NOMBRE && !PALABRAS_IGNORADAS.has(t));
}

/**
 * Dos tokens casan si son iguales o si uno es prefijo del otro y el más corto
 * tiene al menos `MIN_PREFIJO_NOMBRE` letras (nombre truncado por el banco).
 * La comparación es token↔token: no se busca un prefijo suelto como subcadena
 * dentro de otra palabra del plano.
 */
function tokensCasan(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const corto = a.length <= b.length ? a : b;
  const largo = a.length <= b.length ? b : a;
  return corto.length >= MIN_PREFIJO_NOMBRE && largo.startsWith(corto);
}

/**
 * Tokens del nombre de la factura que casan con algún token del movimiento
 * (concepto + refs, tokenizados con la misma regla). No aplica aún el umbral
 * de señal (≥2 o marca bidireccional): eso lo decide `nombreCoincidente`.
 *
 * @param {string} nombre
 * @param {TextosMovimiento} textos
 * @returns {string[]}
 */
export function tokensNombreCoincidentes(nombre, textos) {
  const tokensFactura = tokensNombre(nombre);
  const tokensMov = tokensNombre(textos?.plano || '');
  if (!tokensFactura.length || !tokensMov.length) return [];
  return tokensFactura.filter((tf) => tokensMov.some((tm) => tokensCasan(tf, tm)));
}

/**
 * Tokens que justifican la señal de nombre, o lista vacía.
 *
 * Hace falta:
 * - ≥ 2 tokens de la factura que casen con tokens del movimiento, o
 * - exactamente 1, que sea la marca (primer token distintivo) de la factura,
 *   con longitud ≥ `MIN_TOKEN_NOMBRE_UNICO`, y que además la marca del
 *   movimiento case con algún token de la factura (reconocimiento bidireccional).
 *
 * Así un único genérico tipo DISTRIBUTION↔DISTRIBUCION no basta si las marcas
 * (RESTAURANT vs COMINPORT) no se reconocen entre sí.
 *
 * @param {string} nombre
 * @param {TextosMovimiento} textos
 * @returns {string[]}
 */
export function nombreCoincidente(nombre, textos) {
  const tokensFactura = tokensNombre(nombre);
  const tokensMov = tokensNombre(textos?.plano || '');
  if (!tokensFactura.length || !tokensMov.length) return [];

  const coincidencias = tokensFactura.filter((tf) =>
    tokensMov.some((tm) => tokensCasan(tf, tm)));

  if (coincidencias.length >= 2) return coincidencias;

  if (coincidencias.length === 1) {
    const marcaFactura = tokensFactura[0];
    const marcaMov = tokensMov[0];
    if (
      coincidencias[0] === marcaFactura
      && marcaFactura.length >= MIN_TOKEN_NOMBRE_UNICO
      && tokensFactura.some((tf) => tokensCasan(marcaMov, tf))
    ) {
      return coincidencias;
    }
  }

  return [];
}

/**
 * CIF de la contraparte que casa con el movimiento, o ''.
 *
 * Se mira el campo `nif` (que el lector del extracto ya extrajo) y, si ahí no
 * hay nada, el propio texto: hay formatos que dejan el CIF en la referencia y
 * no en el concepto.
 *
 * @param {string} cifFactura
 * @param {Record<string, any>} movimiento
 * @param {TextosMovimiento} textos
 * @returns {string}
 */
export function cifCoincidente(cifFactura, movimiento, textos) {
  const cif = normalizeCif(cifFactura);
  if (cif.length < MIN_CIF) return '';
  if (normalizeCif(movimiento?.nif) === cif) return cif;
  return (textos?.compacto || '').includes(cif) ? cif : '';
}

/**
 * Primer patrón de exclusión que casa con el movimiento, o ''.
 * @param {TextosMovimiento} textos
 * @param {string[]} patrones
 * @returns {string}
 */
export function patronExcluyente(textos, patrones) {
  const plano = textos?.plano || '';
  if (!plano) return '';
  for (const patron of patrones || []) {
    const p = normalizarTexto(patron);
    if (p && plano.includes(p)) return p;
  }
  return '';
}

