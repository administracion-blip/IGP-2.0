/**
 * Matcher puro del dictado por voz del conteo de inventarios: texto dicho → producto del almacén.
 *
 * Recibe una orden de `parsearDictado` (parser.js) y la lista de productos del almacén. Sin Dynamo,
 * sin red, sin IA. Principio: nunca decide a ciegas; ante la duda, `confirmar: true`. Completar una
 * MARCA sin confirmar está bien («Bombay» → BOMBAY SAPPHIRE); elegir una VARIANTE, un ENVASE o una
 * CATEGORÍA que no se dijo, no.
 *
 * Niveles (de más a menos fiable), probados para cada lectura (principal y alternativas):
 *   5 · exacto     el nombre normalizado (o compacto, «cocacola») es el del producto. via 'exacto'.
 *   4 · alias      alias del usuario/globales (texto normalizado exacto → productId). via 'alias'.
 *   3 · semilla    ALIAS_SEMILLA: el texto dicho al principio se sustituye por un fragmento de nombre.
 *                  via 'semilla'. Si el fragmento no está al principio del nombre → 'semilla_no_anclada'.
 *   2 · palabras   cada palabra dicha es una palabra (o prefijo de ≥3 letras) del nombre, empezando
 *                  por la primera palabra del nombre («Bombay» → BOMBAY SAPPHIRE). via 'palabras':
 *                  no debe aprenderse como alias sin que el usuario lo confirme.
 *   1 · aproximado distancia de edición por palabra («Rocu» → ROKU). via 'aproximado'. Siempre confirma.
 * Un nivel solo gana si da UN producto; si da varios se sigue probando los siguientes (un alias del
 * usuario resuelve un «Johnnie» ambiguo) y, si ninguno resuelve, se devuelve la primera ambigüedad.
 *
 * Palabras que el nombre añade a lo dicho (niveles semilla y palabras):
 * - Tallas (número + unidad: 35cl, 1l, «70 cl», «1,5l», ml, cc, g, kg, oz) y vacías (de, y, la…):
 *   no cuentan.
 * - Envases (tercio, barril, lata, magnum, cristal, botellín…): cuentan para desempatar.
 * - Variantes (zero, sin, red, gran, añejo…) y cualquier número que no sea talla («12», «00», «1906»):
 *   cuentan y, si el producto elegido las añade, piden confirmar ('variante_no_dicha').
 * Con un solo candidato, gana ese (confirma si añade variante). Con varios, gana el que añade un
 * conjunto de palabras contenido estrictamente en el de todos los demás («Coca-Cola» → COCA COLA
 * 35CL frente a COCA COLA ZERO 35CL; «Amstel» → AMSTEL TERCIO frente a AMSTEL 00 TERCIO). Cualquier
 * otro empate → ambiguo, productId null y candidatos.
 * Si todo lo dicho son palabras de categoría («ron», «tónica»), confirma ('generico') salvo que el
 * nombre sea exacto o venga de un alias.
 *
 * Elección de lectura: gana la de nivel más alto; una lectura sin cantidad (en órdenes que la
 * necesitan) solo puede ganar si casa por nombre exacto o alias, y aun así pide 'sin_cantidad'.
 * Si otra lectura casa (nivel ≥ 2) con otro producto u otra cantidad → 'ambiguo'.
 */

import { ALIAS_SEMILLA } from './aliasesSemilla.js';

/** Longitud máxima del texto normalizado de un alias (clave `TXT#<norm>`). */
export const MAX_LONGITUD_ALIAS = 80;

const MAX_CANDIDATOS = 5;
const UMBRAL_APROXIMADO = 0.6;
const MARGEN_EMPATE = 0.05;
const CONFIANZA_CON_AVISO = 0.7;

const NIVEL = Object.freeze({ NADA: 0, APROXIMADO: 1, PALABRAS: 2, SEMILLA: 3, ALIAS: 4, EXACTO: 5 });
const VIA_DE_NIVEL = { 1: 'aproximado', 2: 'palabras', 3: 'semilla', 4: 'alias', 5: 'exacto' };
const CONFIANZA_DE_NIVEL = { 2: 0.9, 3: 0.92, 4: 0.97, 5: 1 };

/** Órdenes del parser que necesitan cantidad. */
const NECESITAN_CANTIDAD = new Set(['linea', 'sumar', 'reemplazar', 'corregir']);

/** Palabras vacías: opcionales al decir el nombre y no distintivas en el producto. */
const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e']);

/** Unidades de talla: solas o tras un número («70 cl») no distinguen productos. */
const UNIDADES_TALLA = new Set(['cl', 'ml', 'l', 'lt', 'lts', 'litro', 'litros', 'cc', 'g', 'gr', 'kg', 'oz']);
const RE_TALLA = /^\d+(cl|ml|l|lt|lts|cc|g|gr|kg|oz)$/;
const RE_NUMERO = /^\d+$/;

/** Variantes: si el producto elegido añade una que no se dijo, se confirma. */
const VARIANTES = new Set([
  'zero', 'cero', 'sin', 'light', 'diet', 'sugarfree', 'free', 'alcohol',
  'gran', 'reserva', 'anejo', 'reposado', 'joven', 'crianza', 'xo', 'vsop', 'vs',
  'blanco', 'blanca', 'dorado', 'dorada', 'oro', 'gold', 'plata', 'silver', 'platinum',
  'black', 'negro', 'negra', 'red', 'rojo', 'roja', 'blue', 'azul', 'green', 'verde', 'white',
  'pink', 'rose', 'rosado', 'rosa', 'tinto', 'rubia', 'tostado', 'tostada',
  'limon', 'lemon', 'lima', 'naranja', 'orange', 'mango', 'fresa', 'vainilla', 'manzana', 'apple',
  'melocoton', 'pina', 'coco', 'cereza', 'cherry', 'frambuesa', 'maracuya', 'tropical', 'mora',
  'especial', 'extra', 'premium', 'seco', 'dry', 'dulce', 'semi', 'brut', 'clasica', 'clasico',
  'doble', 'double', 'edicion', 'limited', 'ipa',
]);

/** Categorías: decir solo esto no identifica un producto. */
const CATEGORIAS = new Set([
  'ron', 'ginebra', 'gin', 'whisky', 'whiskey', 'vodka', 'tequila', 'licor', 'crema', 'cerveza',
  'cana', 'vino', 'cava', 'champan', 'champagne', 'refresco', 'tonica', 'agua', 'zumo', 'vermut',
  'vermouth', 'brandy', 'cognac', 'conac', 'pacharan', 'orujo', 'mezcal', 'sidra', 'anis',
  'aguardiente', 'bitter', 'soda', 'gaseosa', 'limonada', 'cola', 'hielo', 'sake', 'tinto',
]);

const ESPECIALES = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd' };

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------

/**
 * Normaliza un texto para comparar y para usarlo como clave (`TXT#<norm>`): minúsculas, sin acentos
 * ni diéresis (ñ → n), apóstrofos eliminados («Hendrick's» → «hendricks»), cualquier otro carácter
 * que no sea [a-z0-9] pasa a espacio, espacios compactados y recortados. Nunca contiene «#».
 * «Coca-Cola», «COCA COLA» y «coca  cola.» → «coca cola». No limita la longitud (ver normalizarAlias).
 *
 * @param {unknown} texto
 * @returns {string} '' si el texto es null/undefined o no tiene letras ni cifras.
 */
export function normalizarTexto(texto) {
  if (texto == null) return '';
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ßæœøłđ]/g, (c) => ESPECIALES[c])
    .replace(/['’‘`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Versión compacta de `normalizarTexto`, sin espacios: «Coca-Cola» y «cocacola» → «cocacola».
 *
 * @param {unknown} texto
 * @returns {string}
 */
export function normalizarCompacto(texto) {
  return normalizarTexto(texto).replace(/ /g, '');
}

/**
 * Normaliza un alias para su clave `TXT#<norm>`: `normalizarTexto` recortado a MAX_LONGITUD_ALIAS
 * caracteres (sin espacio final).
 *
 * @param {unknown} texto
 * @returns {string}
 */
export function normalizarAlias(texto) {
  return normalizarTexto(texto).slice(0, MAX_LONGITUD_ALIAS).trim();
}

const tokensDe = (norm) => (norm ? norm.split(' ') : []);
const significativos = (tokens) => tokens.filter((t) => !VACIAS.has(t));
const redondear = (n) => Math.round(n * 1000) / 1000;
const claveId = (id) => (id == null ? '' : String(id).trim());
const iterable = (x) => (x != null && typeof x !== 'string' && typeof x[Symbol.iterator] === 'function' ? x : []);

const esUnidadTalla = (t) => t != null && (UNIDADES_TALLA.has(t) || RE_TALLA.test(t));

/** Marca qué palabras de un nombre son talla («35cl», «70 cl», «1 5l»). Un número ante envase no. */
function marcasTalla(tokens) {
  return tokens.map((t, i) => esUnidadTalla(t) || (RE_NUMERO.test(t) && esUnidadTalla(tokens[i + 1])));
}

const esVariante = (t) => VARIANTES.has(t) || RE_NUMERO.test(t);

/**
 * Palabras de envase que no eligen una marca: «bot Ballantines» no es el producto BOT BALLANTINES
 * si en la plantilla hay más Ballantines.
 */
const GENERICOS_MARCA = new Set([
  'bot', 'bots', 'botella', 'botellas', 'caja', 'cajas', 'fila', 'filas',
  'pack', 'packs', 'unidad', 'unidades',
]);

// ---------------------------------------------------------------------------
// Distancia de edición (Damerau-Levenshtein, variante OSA) acotada
// ---------------------------------------------------------------------------

/**
 * Distancia de edición con transposiciones adyacentes. Corta en cuanto supera `max`.
 * @returns {number} distancia, o max + 1 si es mayor que `max`.
 */
function distanciaEdicion(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let ante = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const actual = [i];
    let minFila = i;
    for (let j = 1; j <= b.length; j += 1) {
      const coste = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, actual[j - 1] + 1, prev[j - 1] + coste);
      if (ante && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, ante[j - 2] + 1);
      }
      actual.push(v);
      if (v < minFila) minFila = v;
    }
    if (minFila > max) return max + 1;
    ante = prev;
    prev = actual;
  }
  return prev[b.length];
}

function maxDistancia(longitud) {
  if (longitud < 4) return 0;
  if (longitud <= 5) return 1;
  if (longitud <= 8) return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// Índice
// ---------------------------------------------------------------------------

/**
 * @typedef {{ productId: string|number, nombre: string, familiaNombre?: string, unidad?: string, activo?: boolean }} Producto
 * @typedef {{ texto: string, productId: string|number, usos?: number }} Alias
 * @typedef {{ texto: string, nombre: string }} AliasSemilla
 * @typedef {{
 *   productId: string|number, nombre: string, norm: string,
 *   sig: string[], talla: boolean[], bigramas: string[],
 * }} ProductoIndice
 *   `productId` se conserva tal cual llegó (sin convertir).
 * @typedef {{
 *   productos: ProductoIndice[],
 *   porId: Map<string, number>,
 *   porNorm: Map<string, number[]>,
 *   porCompacto: Map<string, number[]>,
 *   porToken: Map<string, number[]>,
 *   porBigrama: Map<string, number[]>,
 *   vocabulario: string[],
 *   alias: Map<string, number[]>,
 *   aliasCompacto: Map<string, number[]>,
 *   semilla: Map<string, Array<{ tokens: string[], nombre: string }>>,
 * }} Indice
 */

function anadirA(mapa, clave, valor) {
  if (!clave) return;
  const lista = mapa.get(clave);
  if (!lista) mapa.set(clave, [valor]);
  else if (!lista.includes(valor)) lista.push(valor);
}

/**
 * Precalcula normalizaciones y mapas para emparejar rápido en almacenes grandes (~1500 productos).
 * Ignora productos con `activo === false`, sin productId o sin nombre, y productIds repetidos
 * (comparados como texto). Los alias que apuntan a productos que no están en la lista (o están
 * inactivos) se ignoran. Entradas null o no iterables se tratan como vacías.
 *
 * @param {Iterable<Producto>} productos
 * @param {Iterable<Alias>} [alias]
 * @param {{ semilla?: Iterable<AliasSemilla> }} [opciones]
 * @returns {Indice}
 */
export function prepararIndice(productos, alias = [], opciones = {}) {
  const semilla = (opciones ?? {}).semilla ?? ALIAS_SEMILLA;
  /** @type {Indice} */
  const indice = {
    productos: [],
    porId: new Map(),
    porNorm: new Map(),
    porCompacto: new Map(),
    porToken: new Map(),
    porBigrama: new Map(),
    vocabulario: [],
    alias: new Map(),
    aliasCompacto: new Map(),
    semilla: new Map(),
  };
  for (const p of iterable(productos)) {
    if (!p || p.activo === false) continue;
    const clave = claveId(p.productId);
    const nombre = String(p.nombre ?? '').trim();
    const norm = normalizarTexto(nombre);
    if (!clave || !norm || indice.porId.has(clave)) continue;
    const sig = significativos(tokensDe(norm));
    const idx = indice.productos.length;
    const bigramas = sig.slice(0, -1).map((t, i) => t + sig[i + 1]);
    indice.productos.push({ productId: p.productId, nombre, norm, sig, talla: marcasTalla(sig), bigramas });
    indice.porId.set(clave, idx);
    anadirA(indice.porNorm, norm, idx);
    anadirA(indice.porCompacto, norm.replace(/ /g, ''), idx);
    for (const t of sig) anadirA(indice.porToken, t, idx);
    for (const b of bigramas) anadirA(indice.porBigrama, b, idx);
  }
  indice.vocabulario = [...indice.porToken.keys()];

  for (const a of iterable(alias)) {
    const idx = indice.porId.get(claveId(a?.productId));
    const norm = normalizarAlias(a?.texto);
    if (idx === undefined || !norm) continue;
    anadirA(indice.alias, norm, idx);
    anadirA(indice.aliasCompacto, norm.replace(/ /g, ''), idx);
  }

  for (const s of iterable(semilla)) {
    const tokens = tokensDe(normalizarTexto(s?.texto));
    const nombre = normalizarTexto(s?.nombre);
    if (!tokens.length || !nombre) continue;
    const lista = indice.semilla.get(tokens[0]) || [];
    lista.push({ tokens, nombre });
    lista.sort((x, y) => y.tokens.length - x.tokens.length);
    indice.semilla.set(tokens[0], lista);
  }
  return indice;
}

// ---------------------------------------------------------------------------
// Puntuación por palabras
// ---------------------------------------------------------------------------

/**
 * Similitud de una palabra dicha con cada palabra del vocabulario del almacén.
 * 1 = igual; 0.9 = prefijo (≥3 letras); ≤0.85 = aproximada por distancia de edición.
 * Los números solo casan iguales.
 */
function similitudes(q, indice, memo) {
  if (memo.has(q)) return memo.get(q);
  /** @type {Map<string, number>} */
  const m = new Map();
  if (indice.porToken.has(q)) m.set(q, 1);
  if (!RE_NUMERO.test(q)) {
    const maxD = maxDistancia(q.length);
    for (const t of indice.vocabulario) {
      if (t === q) continue;
      if (q.length >= 3 && t.length > q.length && t.startsWith(q)) {
        m.set(t, 0.9);
      } else if (maxD > 0 && !RE_NUMERO.test(t) && Math.abs(t.length - q.length) <= maxD) {
        const d = distanciaEdicion(q, t, maxD);
        if (d <= maxD) m.set(t, Math.min(0.85, 1 - d / Math.max(q.length, t.length)));
      }
    }
  }
  memo.set(q, m);
  return m;
}

/**
 * Puntúa los productos que comparten alguna palabra (o parecida) con lo dicho.
 * `extras`: palabras que el nombre añade (sin tallas ni vacías); `variante`: alguna es variante.
 * @returns {Array<{ idx: number, cobertura: number, fuerte: boolean, anclado: boolean,
 *   extras: Set<string>, variante: boolean, numeroSinCasar: boolean, puntuacion: number }>}
 */
function puntuarPorTokens(qTokens, indice, memo) {
  const qs = significativos(qTokens);
  if (!qs.length) return [];
  const sims = qs.map((q) => similitudes(q, indice, memo));
  const candidatos = new Set();
  qs.forEach((q, k) => {
    for (const t of sims[k].keys()) for (const idx of indice.porToken.get(t) || []) candidatos.add(idx);
    for (const idx of indice.porBigrama.get(q) || []) candidatos.add(idx);
  });

  const out = [];
  for (const idx of candidatos) {
    const p = indice.productos[idx];
    const usados = new Array(p.sig.length).fill(false);
    let suma = 0;
    let fuerte = true;
    let anclado = false;
    let numeroSinCasar = false;
    qs.forEach((q, k) => {
      let mejor = 0;
      let pos = -1;
      p.sig.forEach((t, i) => {
        if (usados[i]) return;
        const s = sims[k].get(t) ?? 0;
        if (s > mejor) {
          mejor = s;
          pos = i;
        }
      });
      let bigrama = -1;
      if (mejor < 1) {
        bigrama = p.bigramas.findIndex((b, i) => b === q && !usados[i] && !usados[i + 1]);
        if (bigrama >= 0) mejor = 1;
      }
      if (bigrama >= 0) {
        usados[bigrama] = true;
        usados[bigrama + 1] = true;
        pos = bigrama;
      } else if (pos >= 0) {
        usados[pos] = true;
      }
      if (k === 0 && pos === 0) anclado = true;
      if (mejor < 0.9) fuerte = false;
      if (mejor === 0 && RE_NUMERO.test(q)) numeroSinCasar = true;
      suma += mejor;
    });
    const cobertura = suma / qs.length;
    const anadidas = p.sig.filter((_, i) => !usados[i] && !p.talla[i]);
    const extras = new Set(anadidas);
    out.push({
      idx, cobertura, fuerte, anclado, extras, numeroSinCasar,
      variante: anadidas.some(esVariante),
      puntuacion: redondear(Math.max(0, Math.min(1, cobertura - 0.05 * Math.min(extras.size, 4)))),
    });
  }
  return out.sort((a, b) => b.puntuacion - a.puntuacion || a.idx - b.idx);
}

const subconjuntoEstricto = (a, b) => a.size < b.size && [...a].every((x) => b.has(x));

/**
 * Decide entre productos que contienen todas las palabras dichas (sin errores).
 * @returns {{ productos: number[], confianza: number, avisos: string[] }|null}
 */
function decidirPorTokens(puntuados, exigirAnclaje) {
  const validos = puntuados.filter((c) => c.fuerte && (c.anclado || !exigirAnclaje));
  if (!validos.length) return null;
  let ganador = null;
  let confianza = 0.9;
  if (validos.length === 1) {
    [ganador] = validos;
  } else {
    ganador = validos.find((c) => validos.every((d) => d === c || subconjuntoEstricto(c.extras, d.extras))) ?? null;
    confianza = 0.85;
  }
  if (!ganador) {
    const orden = [...validos].sort((a, b) => a.extras.size - b.extras.size || b.puntuacion - a.puntuacion || a.idx - b.idx);
    return { productos: orden.map((c) => c.idx), confianza: 0.5, avisos: [] };
  }
  const avisos = [];
  if (ganador.variante) avisos.push('variante_no_dicha');
  if (!ganador.anclado) avisos.push('semilla_no_anclada');
  return { productos: [ganador.idx], confianza, avisos };
}

// ---------------------------------------------------------------------------
// Emparejar una lectura
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   nivel: number, productos: number[], confianza: number, avisos: string[],
 *   candidatos: Map<number, number>,
 * }} ResultadoLectura
 *   `productos`: 1 = resuelto; >1 = ambiguo; 0 = sin coincidencia.
 *   `avisos`: motivos de confirmación del producto resuelto ('variante_no_dicha', 'semilla_no_anclada').
 */

function exactoPorNombre(norm, indice) {
  const hits = new Set([...(indice.porNorm.get(norm) || []), ...(indice.porCompacto.get(norm.replace(/ /g, '')) || [])]);
  return [...hits];
}

function reescribirConSemilla(tokens, indice) {
  const opciones = indice.semilla.get(tokens[0]) || [];
  const s = opciones.find((o) => o.tokens.every((t, i) => tokens[i] === t));
  if (!s) return null;
  return [s.nombre, ...tokens.slice(s.tokens.length)].join(' ');
}

/** @returns {ResultadoLectura} */
function emparejarLectura(textoProducto, indice, memo) {
  /** @type {Map<number, number>} */
  const candidatos = new Map();
  const anotar = (idxs, puntuacion) => {
    for (const idx of idxs) candidatos.set(idx, Math.max(candidatos.get(idx) ?? 0, puntuacion));
  };
  const nada = () => ({ nivel: NIVEL.NADA, productos: [], confianza: 0, avisos: [], candidatos });
  const norm = normalizarTexto(textoProducto);
  if (!norm) return nada();

  const tokens = tokensDe(norm);
  const puntuados = puntuarPorTokens(tokens, indice, memo);
  for (const c of puntuados.slice(0, MAX_CANDIDATOS * 2)) anotar([c.idx], c.puntuacion);

  let primeraAmbigua = null;
  const resultado = (nivel, productos, confianza, avisos = []) => {
    anotar(productos, nivel >= NIVEL.ALIAS ? CONFIANZA_DE_NIVEL[nivel] : 0);
    if (productos.length === 1) return { nivel, productos, confianza, avisos, candidatos };
    primeraAmbigua ||= { nivel, productos, confianza: 0.5, avisos: [], candidatos };
    return null;
  };

  const exacto = exactoPorNombre(norm, indice);
  if (exacto.length) {
    const r = resultado(NIVEL.EXACTO, exacto, 1);
    if (r) return r;
  }

  const normAlias = normalizarAlias(norm);
  const alias = [...new Set([
    ...(indice.alias.get(normAlias) || []),
    ...(indice.aliasCompacto.get(normAlias.replace(/ /g, '')) || []),
  ])];
  if (alias.length) {
    const r = resultado(NIVEL.ALIAS, alias, CONFIANZA_DE_NIVEL[NIVEL.ALIAS]);
    if (r) return r;
  }

  const reescrito = reescribirConSemilla(tokens, indice);
  if (reescrito) {
    const exactoSemilla = exactoPorNombre(reescrito, indice);
    const puntSemilla = exactoSemilla.length ? [] : puntuarPorTokens(tokensDe(reescrito), indice, memo);
    const dec = exactoSemilla.length
      ? { productos: exactoSemilla, confianza: CONFIANZA_DE_NIVEL[NIVEL.SEMILLA], avisos: [] }
      : decidirPorTokens(puntSemilla, false);
    if (dec) {
      for (const c of puntSemilla) if (dec.productos.includes(c.idx)) anotar([c.idx], c.puntuacion);
      // Un único producto: el prefijo («bot») no pide confirmar. Varios, o una variante no dicha, sí.
      const avisos = dec.productos.length === 1
        ? dec.avisos.filter((a) => a !== 'semilla_no_anclada')
        : dec.avisos;
      const r = resultado(NIVEL.SEMILLA, dec.productos, Math.min(dec.confianza, CONFIANZA_DE_NIVEL[NIVEL.SEMILLA]), avisos);
      if (r) return r;
    }
  }

  const porTokens = decidirPorTokens(puntuados, true);
  if (porTokens) {
    const r = resultado(NIVEL.PALABRAS, porTokens.productos, porTokens.confianza, porTokens.avisos);
    if (r) return r;
  }

  // Sin anclar a la primera palabra: si un único producto de la lista contiene lo dicho
  // («Seagrams» → BOT SEAGRAMS), se elige y el prefijo no pide confirmar. Varios siguen ambiguos.
  const suelto = decidirPorTokens(puntuados, false);
  if (suelto) {
    const avisos = suelto.productos.length === 1
      ? suelto.avisos.filter((a) => a !== 'semilla_no_anclada')
      : suelto.avisos;
    const r = resultado(NIVEL.PALABRAS, suelto.productos, suelto.confianza, avisos);
    if (r) return r;
  }

  if (primeraAmbigua) return primeraAmbigua;

  const aprox = puntuados.filter((c) => c.cobertura >= UMBRAL_APROXIMADO && !c.numeroSinCasar);
  if (aprox.length) {
    const mejor = aprox[0];
    const empatados = aprox.filter((c) => c.puntuacion >= mejor.puntuacion - MARGEN_EMPATE).map((c) => c.idx);
    if (empatados.length === 1) {
      return {
        nivel: NIVEL.APROXIMADO, productos: [mejor.idx], confianza: redondear(mejor.puntuacion * 0.8), avisos: [], candidatos,
      };
    }
    return { nivel: NIVEL.APROXIMADO, productos: empatados, confianza: 0.4, avisos: [], candidatos };
  }
  return nada();
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   productId: string|number|null,
 *   nombre: string|null,
 *   lectura: { textoProducto: string|null, cantidad: object|null },
 *   via: 'exacto'|'alias'|'semilla'|'palabras'|'aproximado'|null,
 *   confianza: number,
 *   candidatos: Array<{ productId: string|number, nombre: string, puntuacion: number }>,
 *   confirmar: boolean,
 *   motivos: string[],
 * }} Emparejamiento
 */

/**
 * Empareja una orden del parser con un producto del almacén.
 *
 * Motivos (todos con `confirmar: true` salvo 'sin_producto'):
 * - 'sin_producto': la orden no nombra producto (textoProducto null: «ahora son 10», «pausa»); la UI
 *   usa la última línea.
 * - 'sin_coincidencia': nada razonable (o el texto no tiene letras ni cifras); productId null y
 *   candidatos los más cercanos.
 * - 'ambiguo': varios productos empatan (productId null) u otra lectura casa con otro producto u
 *   otra cantidad (se devuelve la mejor lectura, con productId).
 * - 'aproximado': casa con errores de transcripción (o solo por palabras no iniciales del nombre).
 * - 'variante_no_dicha': el producto elegido añade una variante o un número que no se dijo.
 * - 'semilla_no_anclada': el fragmento de la semilla no está al principio del nombre.
 * - 'generico': todo lo dicho son palabras de categoría («ron», «tónica»).
 * - 'sin_cantidad': la lectura elegida no tiene cantidad y la orden la necesita.
 * - 'confianza_baja': hay producto pero la confianza es < 0,5.
 * `confirmar` solo refleja el emparejamiento; la UI debe combinarlo con `orden.confirmar`.
 *
 * `via` (null si productId es null) y confianza:
 * - 'exacto' (1): nombre completo; seguro para aprender alias.
 * - 'alias' (0,97): alias del usuario/global.
 * - 'semilla' (≤0,92): ALIAS_SEMILLA.
 * - 'palabras' (0,85-0,9): todas las palabras dichas (o prefijos) en el nombre; NO aprender alias
 *   sin confirmación del usuario.
 * - 'aproximado' (≤0,8): con errores de transcripción.
 * Con 'variante_no_dicha', 'semilla_no_anclada', 'generico' o 'ambiguo' la confianza baja a ≤0,7.
 *
 * @param {{ tipo?: string, textoProducto: string|null, cantidad: object|null,
 *   alternativas?: Array<{ textoProducto: string, cantidad: object|null }> }|null} orden
 * @param {{ productos?: Iterable<Producto>, alias?: Iterable<Alias>, semilla?: Iterable<AliasSemilla>,
 *   indice?: Indice }|null} [opciones]
 *   Pasa `indice` (de `prepararIndice`) para no recalcularlo en cada orden; si no, se usan
 *   `productos`, `alias` (prioridad sobre la semilla) y `semilla` (por defecto ALIAS_SEMILLA).
 *   `plantilla` (productos de ESTE conteo) deja ambiguo un nombre de marca que casa con varios
 *   («Bot Ballantines» si hay Ballantines 10 y 12). Un número dicho que solo está en uno no se toca.
 * @returns {Emparejamiento}
 */
export function emparejarProducto(orden, opciones = {}) {
  const { productos = [], alias = [], semilla = ALIAS_SEMILLA, indice } = opciones ?? {};
  const ind = indice || prepararIndice(productos, alias, { semilla });
  const tipo = orden?.tipo ?? 'linea';
  const necesitaCantidad = NECESITAN_CANTIDAD.has(tipo);
  const lecturas = [
    { textoProducto: orden?.textoProducto ?? null, cantidad: orden?.cantidad ?? null },
    ...(Array.isArray(orden?.alternativas) ? orden.alternativas : []).map((a) => ({
      textoProducto: a?.textoProducto ?? null,
      cantidad: a?.cantidad ?? null,
    })),
  ];

  if (lecturas[0].textoProducto == null && lecturas.length === 1) {
    return {
      productId: null, nombre: null, lectura: lecturas[0], via: null, confianza: 0,
      candidatos: [], confirmar: false, motivos: ['sin_producto'],
    };
  }

  const memo = new Map();
  const evaluadas = lecturas.map((lectura, posicion) => {
    const r = emparejarLectura(lectura.textoProducto, ind, memo);
    const completa = !necesitaCantidad || lectura.cantidad != null;
    let efectivo = r.nivel - (r.productos.length > 1 ? 0.25 : 0);
    if (!completa) efectivo = r.nivel >= NIVEL.ALIAS ? efectivo - 0.5 : 0;
    return { lectura, r, efectivo, posicion };
  });
  const ganadora = [...evaluadas].sort((a, b) => b.efectivo - a.efectivo || a.posicion - b.posicion)[0];
  const { r } = ganadora;
  const resuelto = r.productos.length === 1;
  const idxGanador = resuelto ? r.productos[0] : null;
  const totalDe = (l) => l.cantidad?.total ?? null;

  const motivos = [];
  const anadir = (m) => {
    if (!motivos.includes(m)) motivos.push(m);
  };
  let confianza = resuelto ? r.confianza : 0;
  if (r.nivel === NIVEL.NADA) anadir('sin_coincidencia');
  if (r.productos.length > 1) anadir('ambiguo');
  if (r.nivel === NIVEL.APROXIMADO) anadir('aproximado');
  if (resuelto) r.avisos.forEach(anadir);

  const dichas = significativos(tokensDe(normalizarTexto(ganadora.lectura.textoProducto)));
  if (resuelto && r.nivel <= NIVEL.SEMILLA && dichas.length && dichas.every((t) => CATEGORIAS.has(t))) {
    anadir('generico');
  }

  const rival = evaluadas.some((e) => {
    if (e === ganadora || e.r.nivel < NIVEL.PALABRAS) return false;
    const mismo = resuelto && e.r.productos.length === 1 && e.r.productos[0] === idxGanador;
    if (!mismo) return true;
    return totalDe(ganadora.lectura) != null && totalDe(e.lectura) !== totalDe(ganadora.lectura);
  });
  if (rival) anadir('ambiguo');
  if (motivos.some((m) => ['ambiguo', 'variante_no_dicha', 'semilla_no_anclada', 'generico'].includes(m))) {
    confianza = Math.min(confianza, CONFIANZA_CON_AVISO);
  }
  if (resuelto && necesitaCantidad && ganadora.lectura.cantidad == null) anadir('sin_cantidad');
  if (resuelto && confianza < 0.5) anadir('confianza_baja');

  const puntos = new Map();
  for (const e of evaluadas) {
    for (const [idx, p] of e.r.candidatos) puntos.set(idx, Math.max(puntos.get(idx) ?? 0, p));
  }
  const ordenados = [...puntos.entries()]
    .sort((a, b) => (b[0] === idxGanador) - (a[0] === idxGanador) || b[1] - a[1] || a[0] - b[0])
    .slice(0, MAX_CANDIDATOS)
    .map(([idx, puntuacion]) => ({
      productId: ind.productos[idx].productId,
      nombre: ind.productos[idx].nombre,
      puntuacion: redondear(puntuacion),
    }));

  return aplicarPlantilla({
    productId: resuelto ? ind.productos[idxGanador].productId : null,
    nombre: resuelto ? ind.productos[idxGanador].nombre : null,
    lectura: ganadora.lectura,
    via: resuelto ? VIA_DE_NIVEL[r.nivel] : null,
    confianza: redondear(confianza),
    candidatos: ordenados,
    confirmar: motivos.length > 0,
    motivos,
  }, ganadora.lectura.textoProducto, (opciones ?? {}).plantilla);
}

/**
 * Si la marca dicha está en dos o más productos de la plantilla y lo dicho no nombra un número
 * o una palabra que solo tenga uno, no se elige producto (`marca_ambigua`). «Bot» y «caja» no
 * desempata. Sin `plantilla`, el resultado no cambia.
 *
 * @param {Emparejamiento} resultado
 * @param {string|null} textoProducto
 * @param {Iterable<Producto>|null|undefined} plantilla
 * @returns {Emparejamiento}
 */
export function aplicarPlantilla(resultado, textoProducto, plantilla) {
  const dichos = significativos(tokensDe(normalizarTexto(textoProducto)));
  const marca = dichos.filter((t) => !RE_NUMERO.test(t) && !GENERICOS_MARCA.has(t) && !esUnidadTalla(t));
  if (!resultado || marca.length === 0) return resultado;
  const productos = [...iterable(plantilla)].filter((p) => p && p.activo !== false && claveId(p.productId) && p.nombre);
  const familia = productos.filter((p) => {
    const tokens = tokensDe(normalizarTexto(p.nombre));
    return marca.every((t) => tokens.includes(t));
  });
  if (familia.length < 2) return resultado;
  const distingue = dichos.some((t) => {
    if (GENERICOS_MARCA.has(t) || esUnidadTalla(t)) return false;
    return familia.filter((p) => tokensDe(normalizarTexto(p.nombre)).includes(t)).length === 1;
  });
  if (distingue) return resultado;
  const motivos = [...resultado.motivos];
  if (!motivos.includes('ambiguo')) motivos.push('ambiguo');
  if (!motivos.includes('marca_ambigua')) motivos.push('marca_ambigua');
  return {
    ...resultado,
    productId: null,
    nombre: null,
    via: null,
    confianza: redondear(Math.min(resultado.confianza || 0, CONFIANZA_CON_AVISO)),
    candidatos: familia.slice(0, MAX_CANDIDATOS).map((p) => ({
      productId: p.productId,
      nombre: p.nombre,
      puntuacion: 0.5,
    })),
    confirmar: true,
    motivos,
  };
}

/**
 * Vocabulario para el prompt del transcriptor: alias más usados y nombres de la lista que se le
 * pase (la plantilla de este conteo). Primero como mucho 8 alias de más `usos` (no la mitad de
 * la lista: si no, el recorte de 1000 caracteres se queda sin nombres), luego los nombres de más
 * corto a más largo y, si queda hueco, el resto de alias. Sin duplicados (por texto normalizado).
 * Solo textos: nunca
 * stock ni cantidades. Los alias a productos inactivos o que no están en la lista se ignoran.
 *
 * @param {Iterable<Producto>} productos
 * @param {Iterable<Alias>} [alias]
 * @param {{ max?: number }} [opciones]
 * @returns {string[]}
 */
export function vocabularioTranscripcion(productos, alias = [], opciones = {}) {
  const { max = 200 } = opciones ?? {};
  const limite = Math.max(0, Math.floor(Number(max) || 0));
  const activos = [...iterable(productos)].filter((p) => p && p.activo !== false && claveId(p.productId));
  const ids = new Set(activos.map((p) => claveId(p.productId)));
  const aliasValidos = [...iterable(alias)]
    .filter((a) => a && ids.has(claveId(a.productId)) && normalizarTexto(a.texto))
    .map((a, i) => ({ texto: String(a.texto).trim(), usos: Number(a.usos) || 0, i }))
    .sort((a, b) => b.usos - a.usos || a.i - b.i);

  const out = [];
  const vistos = new Set();
  const anadir = (texto) => {
    const n = normalizarTexto(texto);
    if (!n || vistos.has(n) || out.length >= limite) return;
    vistos.add(n);
    out.push(String(texto).trim());
  };
  const porCorto = [...activos].sort((a, b) => {
    const na = String(a.nombre || '').trim();
    const nb = String(b.nombre || '').trim();
    if (na.length !== nb.length) return na.length - nb.length;
    return na.localeCompare(nb, 'es');
  });
  const topeAlias = Math.min(8, Math.floor(limite / 2));
  for (const a of aliasValidos) {
    if (out.length >= topeAlias) break;
    anadir(a.texto);
  }
  for (const p of porCorto) anadir(p.nombre);
  for (const a of aliasValidos) anadir(a.texto);
  return out;
}
