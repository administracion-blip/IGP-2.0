/**
 * Parser puro del dictado por voz del conteo de inventarios.
 *
 * Convierte el texto del transcriptor en órdenes («Roku 7», «suma 3 a Roku»,
 * «Coca-Cola 12 cajas de 24 más 5»…). No conoce productos, no llama a Dynamo,
 * ni a la red, ni a la IA: el emparejamiento texto → producto lo hace quien lo use.
 *
 * Principio: ante la duda, confirmar. Nunca se devuelve una cantidad dudosa con confirmar=false.
 *
 * Decisiones:
 * - Expresiones de cálculo con «×», «+» y «−» (U+2212) y coma decimal: «12×24+5», «10×24−3», «2,5×24».
 *   El transcriptor puede escribir «×», «x» o «*» entre números, «+», «-» o «−»; el guion entre
 *   letras («Coca-Cola») no es resta.
 * - «quita N a <prod>» / «<prod> menos N» es una orden `sumar` con total negativo (stockReal y
 *   botellasAbiertas también negativos). La UI suma totales y vuelve a repartir con partirCantidad.
 *   `calculo.total` es el valor de la expresión, sin el signo de «quita».
 * - Varias órdenes por frase: se separan por «,», «;», «.» o «:» (no decimales) y por «y» cuando
 *   va entre una cantidad y una palabra que no continúa la cantidad («Roku 7 y Larios 12 4»).
 *   Un trozo sin cantidad («corrige», «Roku», «no») se une al siguiente. Un trozo que es UN solo
 *   número («Larios 12, 32») se une al anterior y pide confirmar ('nombre_ambiguo'); con dos o más
 *   números («Roku 7, 818 4») es una orden aparte.
 * - Autocorrección: «no», «perdón», «digo», «mejor dicho» tras una cantidad sustituyen la cantidad
 *   de la orden anterior («Roku 7, no, 8» → Roku 8). Con producto («no, Bombay 8») es `corregir`.
 * - Números del nombre: la cantidad es el sufijo más largo que se lee entero como cantidad
 *   empezando por la izquierda. Dos números seguidos no forman cantidad, así que en
 *   «Larios 12 32» el 12 queda en el nombre y el 32 es la cantidad; con un solo número, es la
 *   cantidad. La otra lectura (número dentro del nombre) va en `alternativas`.
 * - «1.500» (punto + exactamente 3 cifras) son miles y pide confirmar ('numero_ambiguo').
 *   La coma siempre es decimal; «2.5» con 1-2 cifras también.
 * - `cantidad.total` es lo dictado (2,2 en «2 con 20»); stockReal/botellasAbiertas ya van repartidos.
 * - Límites: más de 2000 caracteres lanza errorInventario 400. Cantidades no finitas o con valor
 *   absoluto > 100000 dejan la orden sin cantidad ('cantidad_fuera_de_rango'); eso nunca lanza.
 */

import { BOTELLAS_ABIERTAS, errorInventario } from '../claves.js';

const TOLERANCIA = 1e-6;
const MAX_TEXTO = 2000;
const MAX_CANTIDAD = 100000;

/**
 * @typedef {{ unidadesCaja: number, unidadesPack?: number }} Formato
 * @typedef {{ total: number, stockReal: number, botellasAbiertas: number }} Cantidad
 * @typedef {{ expresion: string, total: number|null, faltaFormato: boolean }} Calculo
 * @typedef {{
 *   tipo: 'linea'|'sumar'|'reemplazar'|'corregir'|'borrar'|'pausa'|'sigue',
 *   textoProducto: string|null,
 *   cantidad: Cantidad|null,
 *   confirmar: boolean,
 *   motivos: string[],
 *   calculo?: Calculo,
 *   alternativas: Array<{ textoProducto: string, cantidad: Cantidad|null }>,
 *   textoOriginal: string,
 * }} Orden
 *   `alternativas`: otras lecturas en las que el primer número de la cantidad forma parte del nombre
 *   («Larios 12» → principal {Larios, 12}, alternativa {«Larios 12», null}; «Larios 12 y media» →
 *   alternativa {«Larios 12», 0,5}). El matcher elige la que case con un producto del almacén;
 *   tener alternativas no obliga a confirmar.
 */

function redondear4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Reparte un total en botellas enteras + fracción de botella abierta.
 * Misma lógica que `partirPropuesta` del frontend: enteras = floor, fracción a 2 decimales
 * llevada a la más cercana de BOTELLAS_ABIERTAS.
 * Un total negativo (delta de «quita») se reparte en valor absoluto y se devuelve con signo.
 *
 * @param {number} total
 * @returns {{ stockReal: number, botellasAbiertas: number, redondeada: boolean }}
 *   `redondeada` es true si la fracción original no era exactamente una de BOTELLAS_ABIERTAS.
 */
export function partirCantidad(total) {
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    throw new TypeError('partirCantidad: el total debe ser un número finito');
  }
  const signo = total < 0 ? -1 : 1;
  const segura = redondear4(Math.abs(total));
  const enteras = Math.floor(segura + TOLERANCIA);
  const fraccionOriginal = segura - enteras;
  const fraccion = Math.round(fraccionOriginal * 100) / 100;
  let mejor = BOTELLAS_ABIERTAS[0];
  let distancia = Infinity;
  for (const b of BOTELLAS_ABIERTAS) {
    const d = Math.abs(b - fraccion);
    if (d < distancia) {
      distancia = d;
      mejor = b;
    }
  }
  return {
    stockReal: signo * enteras || 0,
    botellasAbiertas: signo * mejor || 0,
    redondeada: Math.abs(fraccionOriginal - mejor) > TOLERANCIA,
  };
}

// ---------------------------------------------------------------------------
// Números en español
// ---------------------------------------------------------------------------

const UNIDADES = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
  veintiun: 21, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
  veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};

const DECENAS = {
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
};

const CENTENAS = {
  ciento: 100,
  doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300,
  cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500,
  seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700,
  ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
};

const MEDIA = new Set(['media', 'medio']);
const CUARTOS = new Set(['cuarto', 'cuartos']);
const MAS = new Set(['mas', '+', 'y']);
const MENOS = new Set(['menos', '-', '−']);
const POR = new Set(['por', 'x', '×']);
const ENVASES = {
  caja: 'caja', cajas: 'caja', bandeja: 'caja', bandejas: 'caja', pack: 'pack', packs: 'pack',
};
const NEUTRAS = new Set(['unidad', 'unidades', 'botella', 'botellas']);
const BORRAR = new Set(['borra', 'borrar', 'revierte', 'revertir']);
const CORREGIR = new Set(['corrige', 'corregir', 'correccion']);
const SUMAR = new Set(['suma', 'sumar', 'anade', 'anadir', 'agrega', 'agregar']);
const QUITAR = new Set(['quita', 'quitar', 'resta', 'restar']);
const ANADIDOS = new Set(['anadieron', 'anadio', 'sumaron', 'entraron']);
const CONTROL = {
  pausa: 'pausa', pausar: 'pausa',
  sigue: 'sigue', seguir: 'sigue', continua: 'sigue', continuar: 'sigue',
};
const CORRECCION = new Set(['no', 'perdon', 'digo']);

/** Palabras que solo pueden aparecer dentro de una cantidad. */
const VOCAB_CANTIDAD = new Set([
  'con', 'y', 'de', ...POR, ...MAS, ...MENOS, ...MEDIA, ...CUARTOS, ...NEUTRAS, ...Object.keys(ENVASES),
]);
/** Restos de cantidad que no deberían quedar en el nombre del producto. */
const SOSPECHOSAS = new Set([
  ...Object.keys(ENVASES), ...MEDIA, ...CUARTOS, 'mas', 'menos', 'por', '×', '+', '-', '−',
]);
/** Sospechosas solo si van entre dos números («2 x 3», «2 con 50»). */
const SOSPECHOSAS_ENTRE_NUMEROS = new Set(['x', 'con', 'coma', 'punto', 'y', 'de']);

function normalizar(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function esUnidad1a9(norm) {
  const v = UNIDADES[norm];
  return v !== undefined && v >= 1 && v <= 9;
}

/** Lee 0..999 en palabras desde `i`. Devuelve { valor, j } o null. */
function leerMenorDeMil(normas, i) {
  let j = i;
  let valor = 0;
  let algo = false;
  if (normas[j] === 'cien') return { valor: 100, j: j + 1 };
  if (CENTENAS[normas[j]] !== undefined) {
    valor += CENTENAS[normas[j]];
    j += 1;
    algo = true;
  }
  const t = normas[j];
  if (DECENAS[t] !== undefined) {
    valor += DECENAS[t];
    j += 1;
    algo = true;
    if (normas[j] === 'y' && esUnidad1a9(normas[j + 1])) {
      valor += UNIDADES[normas[j + 1]];
      j += 2;
    }
  } else if (UNIDADES[t] !== undefined && !(algo && UNIDADES[t] === 0)) {
    valor += UNIDADES[t];
    j += 1;
    algo = true;
  }
  return algo ? { valor, j } : null;
}

/** Lee un número en palabras (hasta 999.999) desde `i`. Devuelve { valor, j } o null. */
function leerNumeroPalabras(normas, i) {
  const r = leerMenorDeMil(normas, i);
  const j = r ? r.j : i;
  if (normas[j] !== 'mil') return r;
  let valor = (r ? r.valor : 1) * 1000;
  let fin = j + 1;
  const resto = leerMenorDeMil(normas, fin);
  if (resto) {
    valor += resto.valor;
    fin = resto.j;
  }
  return { valor, j: fin };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const SEP = Object.freeze({ tipo: 'sep' });
const RE_DIGITOS = /^\d+([.,]\d+)?$/;
const RE_MILES = /^\d{1,3}(\.\d{3})+$/;

/** Parte el texto en palabras y separadores (`,` `;` `.` `:` que no sean decimales). */
function tokenizar(texto) {
  let s = String(texto ?? '');
  s = s.replace(/[“”"«»¿?¡!()]/g, ' ');
  s = s.replace(/[×*]/g, ' × ').replace(/(\d)\s*[xX]\s*(?=\d)/g, '$1 × ');
  s = s.replace(/−/g, ' − ').replace(/(\d)\s*-\s*(?=\d)/g, '$1 - ').replace(/\+/g, ' + ');
  s = s.replace(/(\d),(\d)/g, '$1\u0001$2').replace(/(\d)\.(\d)/g, '$1\u0002$2');
  s = s.replace(/[,;.:]/g, ' , ');
  s = s.replace(/\u0001/g, ',').replace(/\u0002/g, '.');
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((orig) => (orig === ',' ? SEP : { tipo: 'palabra', orig, norm: normalizar(orig) }));
}

function numeroDeDigitos(tok) {
  if (RE_MILES.test(tok.orig)) {
    return {
      tipo: 'num',
      valor: Number(tok.orig.replace(/\./g, '')),
      digitos: tok.orig.replace(/\./g, ''),
      decimal: false,
      ambiguo: true,
      orig: tok.orig,
    };
  }
  return {
    tipo: 'num',
    valor: Number(tok.orig.replace(',', '.')),
    digitos: tok.orig,
    decimal: /[.,]/.test(tok.orig),
    orig: tok.orig,
  };
}

/** Lee un número (dígitos o palabras) desde `i` sin decimales hablados. */
function leerNumeroSimple(toks, normas, i) {
  const tok = toks[i];
  if (!tok || tok.tipo !== 'palabra') return null;
  if (RE_DIGITOS.test(tok.orig) || RE_MILES.test(tok.orig)) return { num: numeroDeDigitos(tok), j: i + 1 };
  const r = leerNumeroPalabras(normas, i);
  if (!r) return null;
  const origs = toks.slice(i, r.j).map((t) => t.orig).join(' ');
  return {
    num: { tipo: 'num', valor: r.valor, digitos: String(r.valor), decimal: false, orig: origs },
    j: r.j,
  };
}

/** Convierte palabras numéricas en elementos `num`; acepta «dos coma cinco». */
function convertir(toks) {
  const normas = toks.map((t) => (t.tipo === 'palabra' ? t.norm : null));
  const items = [];
  let i = 0;
  while (i < toks.length) {
    const tok = toks[i];
    if (tok.tipo === 'sep') {
      items.push(SEP);
      i += 1;
      continue;
    }
    const leido = leerNumeroSimple(toks, normas, i);
    if (!leido) {
      items.push(tok);
      i += 1;
      continue;
    }
    let { num, j } = leido;
    const sep = toks[j];
    if (!num.decimal && !num.ambiguo && sep?.tipo === 'palabra' && (sep.norm === 'coma' || sep.norm === 'punto')) {
      const frac = leerNumeroSimple(toks, normas, j + 1);
      if (frac && !frac.num.decimal && !frac.num.ambiguo) {
        const valor = num.valor + Number(`0.${frac.num.digitos}`);
        num = {
          tipo: 'num',
          valor,
          digitos: String(valor),
          decimal: true,
          orig: `${num.orig} ${sep.orig} ${frac.num.orig}`,
        };
        j = frac.j;
      }
    }
    items.push(num);
    i = j;
  }
  return items;
}

const esNum = (it) => it?.tipo === 'num';
const normDe = (it) => (it?.tipo === 'palabra' ? it.norm : null);
const textoDe = (items) => items.map((it) => it.orig).join(' ');
const esTokenCantidad = (it) => esNum(it) || VOCAB_CANTIDAD.has(normDe(it));

/**
 * Convierte un texto en número: dígitos («2,5», «2.5», «1.500»), palabras («treinta y dos»,
 * «ciento veinte», «mil doscientos»), «dos coma cinco», «tres y media», «tres y cuarto», «medio».
 *
 * @param {string} texto
 * @returns {number|null} null si el texto no es solo un número o no es finito.
 */
export function numeroEnPalabras(texto) {
  const items = convertir(tokenizar(texto)).filter((it) => it !== SEP);
  const cant = leerCantidad(items, () => null);
  if (!cant || cant.esCalculo || !Number.isFinite(cant.total)) return null;
  return cant.total;
}

// ---------------------------------------------------------------------------
// Cantidades y cálculos
// ---------------------------------------------------------------------------

function fmt(n) {
  return String(redondear4(n)).replace('.', ',');
}

function unidadesValidas(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** «y media», «y cuarto», «y un cuarto», «y tres cuartos» desde `j`. */
function leerFraccionY(items, j) {
  if (normDe(items[j]) !== 'y') return null;
  const a = normDe(items[j + 1]);
  if (MEDIA.has(a)) return { suma: 0.5, j: j + 2 };
  if (a === 'cuarto') return { suma: 0.25, j: j + 2 };
  const n = items[j + 1];
  if (esNum(n) && !n.decimal) {
    const tras = normDe(items[j + 2]);
    if (n.valor === 1 && tras === 'cuarto') return { suma: 0.25, j: j + 3 };
    if (n.valor === 3 && tras === 'cuartos') return { suma: 0.75, j: j + 3 };
  }
  return null;
}

/**
 * Un término: «7», «media», «2 con 20», «3 y media», «3 y cuarto», «7 media» (dudoso),
 * «12 cajas [y media] [de 24]», «9 por 24».
 * Devuelve { valor|null, expr, calc, faltaFormato, dudoso, j } o null.
 */
function leerTermino(items, i, obtenerFormato) {
  const it = items[i];
  let base;
  if (esNum(it)) base = it.valor;
  else if (MEDIA.has(normDe(it))) base = 0.5;
  else return null;
  let j = i + 1;
  let dudoso = false;
  const w = (k) => normDe(items[k]);

  if (w(j) === 'con' && esNum(items[j + 1]) && !items[j + 1].decimal && Number.isInteger(base)) {
    const valor = base + Number(`0.${items[j + 1].digitos}`);
    return { valor, expr: fmt(valor), calc: false, faltaFormato: false, dudoso, j: j + 2 };
  }
  const fy = leerFraccionY(items, j);
  if (fy) {
    base += fy.suma;
    j = fy.j;
  } else if (esNum(it) && Number.isInteger(base) && MEDIA.has(w(j))) {
    base += 0.5;
    dudoso = true;
    j += 1;
  }
  const envase = ENVASES[w(j)];
  if (envase) {
    j += 1;
    const fy2 = leerFraccionY(items, j);
    if (fy2) {
      base += fy2.suma;
      j = fy2.j;
    }
    let m = null;
    if (w(j) === 'de' && esNum(items[j + 1])) {
      m = items[j + 1].valor > 0 ? items[j + 1].valor : null;
      j += 2;
    } else {
      const formato = obtenerFormato();
      m = unidadesValidas(envase === 'pack' ? formato?.unidadesPack : formato?.unidadesCaja);
    }
    if (m == null) return { valor: null, expr: `${fmt(base)}×?`, calc: true, faltaFormato: true, dudoso, j };
    return { valor: base * m, expr: `${fmt(base)}×${fmt(m)}`, calc: true, faltaFormato: false, dudoso, j };
  }
  if (POR.has(w(j)) && esNum(items[j + 1])) {
    const m = items[j + 1].valor;
    return { valor: base * m, expr: `${fmt(base)}×${fmt(m)}`, calc: true, faltaFormato: false, dudoso, j: j + 2 };
  }
  if (NEUTRAS.has(w(j))) j += 1;
  return { valor: base, expr: fmt(base), calc: false, faltaFormato: false, dudoso, j };
}

/**
 * Lee `items` entero como cantidad: término (op término)*, op ∈ más/y/+ | menos/-/−.
 * Devuelve { total|null, expresion, esCalculo, faltaFormato, dudoso } o null si sobra algo.
 */
function leerCantidad(items, obtenerFormato) {
  if (!items.length) return null;
  const primero = leerTermino(items, 0, obtenerFormato);
  if (!primero) return null;
  let total = primero.valor;
  let expresion = primero.expr;
  let esCalculo = primero.calc;
  let faltaFormato = primero.faltaFormato;
  let dudoso = primero.dudoso;
  let j = primero.j;
  while (j < items.length) {
    const w = normDe(items[j]);
    const op = MAS.has(w) ? '+' : MENOS.has(w) ? '−' : null;
    if (!op) return null;
    const t = leerTermino(items, j + 1, obtenerFormato);
    if (!t) return null;
    expresion += op + t.expr;
    esCalculo = true;
    faltaFormato ||= t.faltaFormato;
    dudoso ||= t.dudoso;
    total = total == null || t.valor == null ? null : op === '+' ? total + t.valor : total - t.valor;
    j = t.j;
  }
  return { total: total == null ? null : redondear4(total), expresion, esCalculo, faltaFormato, dudoso };
}

function buscarFormato(formatos, clave) {
  if (!formatos || clave == null) return null;
  const entradas = formatos instanceof Map ? [...formatos.entries()] : Object.entries(formatos);
  const exacta = entradas.find(([k]) => k === clave);
  if (exacta) return exacta[1];
  const n = normalizar(clave).trim();
  return entradas.find(([k]) => normalizar(k).trim() === n)?.[1] ?? null;
}

function formatoPara(textoProducto, opciones) {
  if (typeof opciones.resolverFormato === 'function') {
    const r = opciones.resolverFormato(textoProducto);
    if (r) return r;
  }
  return buscarFormato(opciones.formatos, textoProducto ?? opciones.productId ?? null);
}

/** Otra lectura: el primer número de la cantidad pasa al nombre. */
function alternativaDe(prod, sufijo, opciones) {
  if (!prod.length || !esNum(sufijo[0])) return [];
  const prodAlt = [...prod, sufijo[0]];
  let resto = sufijo.slice(1);
  if (normDe(resto[0]) === 'y') resto = resto.slice(1);
  if (!resto.length) return [{ prod: prodAlt, cant: null }];
  const cant = leerCantidad(resto, () => formatoPara(textoDe(prodAlt), opciones));
  return cant ? [{ prod: prodAlt, cant }] : [];
}

/**
 * Separa «<producto> <cantidad>»: primer índice desde el que el resto se lee entero como cantidad.
 * Solo se prueba dentro del sufijo formado por tokens de cantidad (coste lineal en el nombre).
 */
function separarProductoCantidad(items, opciones) {
  let inicio = items.length;
  while (inicio > 0 && esTokenCantidad(items[inicio - 1])) inicio -= 1;
  for (let k = inicio; k < items.length; k += 1) {
    if (!esNum(items[k]) && !MEDIA.has(normDe(items[k]))) continue;
    const prod = items.slice(0, k);
    const sufijo = items.slice(k);
    const cant = leerCantidad(sufijo, () => formatoPara(prod.length ? textoDe(prod) : null, opciones));
    if (cant) return { prod, cant, alternativas: alternativaDe(prod, sufijo, opciones) };
  }
  return { prod: items, cant: null, alternativas: [] };
}

/** ¿Quedan en el nombre restos de cantidad sin consumir? */
function tieneRestosDeCantidad(items) {
  return items.some((it, k) => {
    const w = normDe(it);
    if (SOSPECHOSAS.has(w)) return true;
    if (SOSPECHOSAS_ENTRE_NUMEROS.has(w) && esNum(items[k - 1]) && esNum(items[k + 1])) return true;
    return esNum(it) && esNum(items[k + 1]);
  });
}

/** Cantidad repartida o fuera de rango (no finita o |total| > MAX_CANTIDAD). */
function cantidadDe(total) {
  if (!Number.isFinite(total) || Math.abs(total) > MAX_CANTIDAD) return { fuera: true };
  const t = redondear4(total) || 0;
  const p = partirCantidad(t);
  return {
    cantidad: { total: t, stockReal: p.stockReal, botellasAbiertas: p.botellasAbiertas },
    redondeada: p.redondeada,
  };
}

function construirOrden(tipo, prodItems, cant, textoOriginal, signo = 1, alternativas = []) {
  const motivos = [];
  let cantidad = null;
  let calculo;
  if (cant) {
    if (cant.esCalculo) {
      calculo = {
        expresion: cant.expresion,
        total: Number.isFinite(cant.total) ? cant.total : null,
        faltaFormato: cant.faltaFormato,
      };
      motivos.push('calculo');
      if (cant.faltaFormato) motivos.push('falta_formato');
    }
    if (cant.total != null) {
      const r = cantidadDe(signo * cant.total);
      if (r.fuera) {
        motivos.push('cantidad_fuera_de_rango');
      } else {
        cantidad = r.cantidad;
        if (r.redondeada) motivos.push('fraccion_redondeada');
        if (cantidad.total < 0 && tipo !== 'sumar') motivos.push('total_negativo');
      }
    }
    if (cant.dudoso) motivos.push('revisar_texto');
  } else {
    motivos.push('sin_cantidad');
  }
  if (tieneRestosDeCantidad(prodItems) && !motivos.includes('revisar_texto')) motivos.push('revisar_texto');
  const orden = {
    tipo,
    textoProducto: prodItems.length ? textoDe(prodItems) : null,
    cantidad,
    confirmar: motivos.length > 0,
    motivos,
    alternativas: alternativas.map((a) => {
      const r = a.cant?.total != null ? cantidadDe(signo * a.cant.total) : null;
      return { textoProducto: textoDe(a.prod), cantidad: r?.cantidad ?? null };
    }),
    textoOriginal,
  };
  if (calculo) orden.calculo = calculo;
  return orden;
}

function ordenSinCantidad(tipo, textoProducto, textoOriginal) {
  return { tipo, textoProducto, cantidad: null, confirmar: false, motivos: [], alternativas: [], textoOriginal };
}

/** Interpreta un trozo ya separado como una sola orden. */
function interpretar(pieza, opciones) {
  const { items, texto } = pieza;
  const n = items.length;
  const w = (k) => normDe(items[k]);

  if (n === 1 && CONTROL[w(0)]) return ordenSinCantidad(CONTROL[w(0)], null, texto);
  if (BORRAR.has(w(0))) {
    const prod = items.slice(1);
    return ordenSinCantidad('borrar', prod.length ? textoDe(prod) : null, texto);
  }

  const iAhora = items.findIndex((it, k) => normDe(it) === 'ahora' && ['son', 'hay', 'es'].includes(w(k + 1)));
  if (iAhora >= 0) {
    let prod = items.slice(0, iAhora);
    if (CORREGIR.has(normDe(prod[0]))) prod = prod.slice(1);
    const textoProd = prod.length ? textoDe(prod) : null;
    const cant = leerCantidad(items.slice(iAhora + 2), () => formatoPara(textoProd, opciones));
    return construirOrden('reemplazar', prod, cant, texto);
  }

  if (CORREGIR.has(w(0))) {
    const { prod, cant, alternativas } = separarProductoCantidad(items.slice(1), opciones);
    return construirOrden('corregir', prod, cant, texto, 1, alternativas);
  }

  if (SUMAR.has(w(0)) || QUITAR.has(w(0))) {
    const signo = QUITAR.has(w(0)) ? -1 : 1;
    const resto = items.slice(1);
    const iA = resto.findIndex((it) => normDe(it) === 'a' || normDe(it) === 'al');
    if (iA > 0) {
      const prod = resto.slice(iA + 1);
      const textoProd = prod.length ? textoDe(prod) : null;
      const cant = leerCantidad(resto.slice(0, iA), () => formatoPara(textoProd, opciones));
      return construirOrden('sumar', prod, cant, texto, signo);
    }
    const { prod, cant, alternativas } = separarProductoCantidad(resto, opciones);
    return construirOrden('sumar', prod, cant, texto, signo, alternativas);
  }

  const inicioAnadidos = w(0) === 'se' && ANADIDOS.has(w(1)) ? 2 : ANADIDOS.has(w(0)) ? 1 : -1;
  if (inicioAnadidos > 0) {
    const resto = items.slice(inicioAnadidos);
    let fin = 0;
    while (fin < resto.length && esTokenCantidad(resto[fin])) fin += 1;
    for (let j = fin; j > 0; j -= 1) {
      const prod = resto.slice(j);
      const textoProd = prod.length ? textoDe(prod) : null;
      const cant = leerCantidad(resto.slice(0, j), () => formatoPara(textoProd, opciones));
      if (cant) return construirOrden('sumar', prod, cant, texto);
    }
    return construirOrden('sumar', resto, null, texto);
  }

  if ((w(0) === 'mas' || w(0) === 'menos') && n > 1) {
    const { prod, cant, alternativas } = separarProductoCantidad(items.slice(1), opciones);
    return construirOrden('sumar', prod, cant, texto, w(0) === 'menos' ? -1 : 1, alternativas);
  }

  if ((w(n - 1) === 'mas' || w(n - 1) === 'menos') && n > 1) {
    const { prod, cant, alternativas } = separarProductoCantidad(items.slice(0, n - 1), opciones);
    return construirOrden('sumar', prod, cant, texto, w(n - 1) === 'menos' ? -1 : 1, alternativas);
  }

  const { prod, cant, alternativas } = separarProductoCantidad(items, opciones);
  // «<prod> más N» / «<prod> suma N» / «<prod> menos N»: el verbo quedó al final del nombre.
  const ultima = normDe(prod[prod.length - 1]);
  if (cant && prod.length > 1 && (ultima === 'mas' || SUMAR.has(ultima) || ultima === 'menos' || QUITAR.has(ultima))) {
    const signo = ultima === 'menos' || QUITAR.has(ultima) ? -1 : 1;
    const prodSin = prod.slice(0, -1);
    const alt = alternativaDe(prodSin, items.slice(prod.length), opciones);
    return construirOrden('sumar', prodSin, cant, texto, signo, alt);
  }
  return construirOrden('linea', prod, cant, texto, 1, alternativas);
}

// ---------------------------------------------------------------------------
// Separación en órdenes
// ---------------------------------------------------------------------------

const tieneCantidad = (items) => items.some((it) => esNum(it) || MEDIA.has(normDe(it)));
const esAutonoma = (items) => (items.length === 1 && CONTROL[normDe(items[0])]) || BORRAR.has(normDe(items[0]));
const NO_CONTINUA_Y = new Set([...MEDIA, ...CUARTOS, ...MAS, ...MENOS]);

/** Nº de tokens de autocorrección al principio («no», «perdón», «digo», «mejor dicho»). */
function prefijoCorreccion(items) {
  let k = 0;
  for (;;) {
    if (CORRECCION.has(normDe(items[k]))) k += 1;
    else if (normDe(items[k]) === 'mejor' && normDe(items[k + 1]) === 'dicho') k += 2;
    else return k;
  }
}

/**
 * Corta un trozo en «y» entre una cantidad y una palabra que no continúa la cantidad,
 * y antes de una autocorrección que sigue a una cantidad («Roku 7 no 8»).
 */
function partirTrozo(items) {
  const trozos = [];
  let actual = [];
  items.forEach((it, k) => {
    const prev = items[k - 1];
    const next = items[k + 1];
    const tras = esNum(prev) || MEDIA.has(normDe(prev)) || CUARTOS.has(normDe(prev));
    const corta = actual.length > 0 && tras && prefijoCorreccion(items.slice(k, k + 2)) > 0;
    const cortaY =
      normDe(it) === 'y' &&
      actual.length > 0 &&
      next?.tipo === 'palabra' &&
      (tras || normDe(prev) === 'mas') &&
      !NO_CONTINUA_Y.has(next.norm);
    if (corta) {
      trozos.push(actual);
      actual = [it];
    } else if (cortaY) {
      trozos.push(actual);
      actual = [];
    } else {
      actual.push(it);
    }
  });
  if (actual.length) trozos.push(actual);
  return trozos;
}

function separarPiezas(items) {
  const brutos = [];
  let actual = [];
  for (const it of items) {
    if (it === SEP) {
      if (actual.length) brutos.push(actual);
      actual = [];
    } else {
      actual.push(it);
    }
  }
  if (actual.length) brutos.push(actual);

  const piezas = brutos.flatMap(partirTrozo).map((t) => ({ items: t, texto: textoDe(t), fusionNumero: false }));
  const unir = (a, b) => ({
    items: [...a.items, ...b.items],
    texto: `${a.texto}, ${b.texto}`,
    fusionNumero: a.fusionNumero || b.fusionNumero,
  });

  const resultado = [];
  let pendiente = null;
  for (let p of piezas) {
    if (pendiente) {
      p = unir(pendiente, p);
      pendiente = null;
    }
    if (!tieneCantidad(p.items) && !esAutonoma(p.items)) {
      pendiente = p;
      continue;
    }
    const anterior = resultado[resultado.length - 1];
    if (
      anterior &&
      p.items.length === 1 &&
      esNum(p.items[0]) &&
      !esAutonoma(anterior.items) &&
      prefijoCorreccion(anterior.items) === 0
    ) {
      resultado[resultado.length - 1] = { ...unir(anterior, p), fusionNumero: true };
      continue;
    }
    resultado.push(p);
  }
  if (pendiente) resultado.push(pendiente);
  return resultado;
}

const MOTIVOS_CANTIDAD = new Set([
  'calculo', 'falta_formato', 'fraccion_redondeada', 'sin_cantidad', 'total_negativo',
  'cantidad_fuera_de_rango', 'numero_ambiguo',
]);

function anadirMotivo(orden, motivo) {
  if (!orden.motivos.includes(motivo)) orden.motivos.push(motivo);
  orden.confirmar = true;
}

function interpretarPieza(pieza, opciones) {
  const orden = interpretar(pieza, opciones);
  if (pieza.items.some((it) => it.ambiguo)) anadirMotivo(orden, 'numero_ambiguo');
  if (pieza.fusionNumero) anadirMotivo(orden, 'nombre_ambiguo');
  return orden;
}

/**
 * Autocorrección: sin producto sustituye la cantidad de la orden anterior (devuelve null);
 * con producto devuelve una orden `corregir`.
 */
function aplicarCorreccion(pieza, saltar, ordenes, opciones) {
  const resto = { items: pieza.items.slice(saltar), texto: pieza.texto, fusionNumero: pieza.fusionNumero };
  const anterior = ordenes[ordenes.length - 1];
  const conCantidad = anterior && ['linea', 'sumar', 'reemplazar', 'corregir'].includes(anterior.tipo);
  const opcResto =
    conCantidad && anterior.textoProducto
      ? { ...opciones, resolverFormato: (t) => formatoPara(t ?? anterior.textoProducto, opciones) }
      : opciones;
  const o = interpretarPieza(resto, opcResto);
  if (resto.items.length && o.tipo === 'linea' && o.textoProducto === null && conCantidad) {
    const nueva = {
      ...anterior,
      cantidad: o.cantidad,
      motivos: [...anterior.motivos.filter((m) => !MOTIVOS_CANTIDAD.has(m)), ...o.motivos],
      alternativas: [],
      textoOriginal: `${anterior.textoOriginal}, ${pieza.texto}`,
    };
    delete nueva.calculo;
    if (o.calculo) nueva.calculo = o.calculo;
    anadirMotivo(nueva, 'autocorreccion');
    ordenes[ordenes.length - 1] = nueva;
    return null;
  }
  const corr = { ...o, tipo: o.tipo === 'linea' ? 'corregir' : o.tipo, motivos: [...o.motivos] };
  anadirMotivo(corr, 'autocorreccion');
  return corr;
}

/**
 * Interpreta una frase dictada en una o varias órdenes.
 *
 * Órdenes reconocidas:
 * - «<prod> <cantidad>» → `linea`. Cantidad: «7», «siete», «2,5», «dos coma cinco», «3 y media»,
 *   «3 y cuarto», «3 y tres cuartos», «2 con 20» (= 2,20), «12 cajas [y media] [de 24] [más|y 5]
 *   [menos 3]», «9 por 24», «10×24−3».
 * - «[<prod>] ahora son N» → `reemplazar` (sin producto: textoProducto null, la UI aplica a la última línea).
 * - «suma N a <prod>», «<prod> N más», «<prod> más N», «<prod> suma N», «se añadieron N <prod>»,
 *   «más N» → `sumar`.
 * - «quita N a <prod>», «<prod> N menos», «<prod> menos N», «menos N» → `sumar` con total negativo.
 * - «corrige[,] <prod> N» → `corregir`.  «borra|revierte <prod>» → `borrar`.
 * - «…, no, N» / «perdón N» / «digo N» / «mejor dicho N» → sustituye la cantidad de la orden anterior;
 *   «no, <prod> N» → `corregir`. Ambas con 'autocorreccion'.
 * - «pausa» → `pausa`; «sigue» / «continúa» → `sigue`.
 *
 * Motivos (con `confirmar: true`): 'calculo', 'falta_formato', 'fraccion_redondeada', 'sin_cantidad',
 * 'total_negativo', 'revisar_texto' (quedan restos de cantidad en el nombre o «7 media»),
 * 'nombre_ambiguo' (número suelto tras coma unido a la orden anterior), 'numero_ambiguo' («1.500»),
 * 'autocorreccion', 'cantidad_fuera_de_rango'.
 *
 * @param {string} texto Texto del transcriptor (máximo 2000 caracteres).
 * @param {{
 *   formatos?: Map<string, Formato>|Record<string, Formato>,
 *   resolverFormato?: (textoProducto: string|null) => Formato|null,
 *   productId?: string,
 * }} [opciones]
 *   Para «N cajas|packs|bandejas» sin «de M» se usa `resolverFormato(textoProducto)`; si no hay
 *   resultado, se busca en `formatos` por textoProducto (sin distinguir mayúsculas ni acentos) o,
 *   si la orden no nombra producto, por `productId` (producto activo de la UI).
 *   Cajas y bandejas usan `unidadesCaja`; packs, `unidadesPack`. Sin formato: faltaFormato y sin total.
 * @returns {{ ordenes: Orden[] }}
 * @throws errorInventario 400 «El dictado es demasiado largo.» si supera 2000 caracteres.
 */
export function parsearDictado(texto, opciones = {}) {
  const s = String(texto ?? '');
  if (s.length > MAX_TEXTO) throw errorInventario('El dictado es demasiado largo.', 400);
  const opc = opciones ?? {};
  const ordenes = [];
  for (const pieza of separarPiezas(convertir(tokenizar(s)))) {
    const saltar = prefijoCorreccion(pieza.items);
    const orden = saltar > 0 ? aplicarCorreccion(pieza, saltar, ordenes, opc) : interpretarPieza(pieza, opc);
    if (orden) ordenes.push(orden);
  }
  return { ordenes };
}
