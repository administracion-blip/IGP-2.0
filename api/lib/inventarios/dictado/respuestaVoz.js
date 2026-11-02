/**
 * Respuesta hablada a la pregunta abierta del dictado («el 10», «sí», «no»).
 * No crea una línea nueva: quien llama actualiza la que está pendiente.
 * Un conteo («Larios 3») no es una respuesta y devuelve null.
 */

import { normalizarTexto } from './matcher.js';

const SI = new Set(['si']);
const NO = new Set(['no']);

const NUMEROS = {
  cero: '0', uno: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5',
  seis: '6', siete: '7', ocho: '8', nueve: '9', diez: '10', once: '11',
  doce: '12', trece: '13', catorce: '14', quince: '15',
};

/** Motivos de duda que desaparecen cuando el usuario elige un producto. */
export const MOTIVOS_RESUELTOS_POR_ELECCION = [
  'ambiguo', 'marca_ambigua', 'sin_coincidencia', 'no_en_plantilla', 'sin_producto', 'propuesto_ia',
];

const PIDEN_CONFIRMAR = new Set([
  'ya_contado', 'repetido_en_dictado', 'calculo', 'falta_formato', 'redondeo', 'revisar_texto',
  'nombre_ambiguo', 'total_negativo', 'variante_no_dicha', 'sin_cantidad', 'generico', 'aproximado',
  'confianza_baja', 'cantidad_fuera_de_rango',
]);

/**
 * @param {unknown} texto
 * @param {{ candidatos?: Array<{ productId: string|number, nombre?: string }> }} [linea]
 * @returns {{ tipo: 'si' } | { tipo: 'no' } | { tipo: 'elegir', productId: string, nombre: string } | null}
 */
export function resolverRespuesta(texto, linea) {
  const tokens = normalizarTexto(texto).split(' ').filter(Boolean);
  if (!linea || tokens.length === 0 || tokens.length > 6) return null;
  if (tokens.length === 1 && SI.has(tokens[0])) return { tipo: 'si' };
  if (tokens.length === 1 && NO.has(tokens[0])) return { tipo: 'no' };
  const elegido = elegirCandidato(tokens, linea.candidatos || []);
  if (!elegido) return null;
  return { tipo: 'elegir', productId: String(elegido.productId), nombre: String(elegido.nombre || elegido.productId) };
}

/**
 * «el 10» / «el diez» elige por el número del nombre. Sin artículo, un número suelto
 * es una cantidad, no una elección. El resto tiene que coincidir con un solo candidato.
 */
function elegirCandidato(tokens, candidatos) {
  const conArticulo = tokens[0] === 'el' || tokens[0] === 'la';
  const cuerpo = conArticulo ? tokens.slice(1) : tokens;
  if (cuerpo.length === 0) return null;
  const palabraNumero = NUMEROS[cuerpo[0]] || (/^\d+$/.test(cuerpo[0]) ? cuerpo[0] : null);
  if (!conArticulo && cuerpo.length === 1 && palabraNumero) return null;
  const frase = cuerpo.join(' ');
  const hits = (candidatos || []).filter((c) => {
    const nombre = normalizarTexto(c?.nombre);
    if (!nombre) return false;
    const partes = nombre.split(' ');
    if (conArticulo && cuerpo.length === 1 && palabraNumero) return partes.includes(palabraNumero);
    return nombre === frase || partes.join(' ').includes(frase);
  });
  return hits.length === 1 ? hits[0] : null;
}

/** @param {string[]} motivos @param {{ yaContado?: boolean }} [opciones] */
export function motivosTrasElegir(motivos, { yaContado = false } = {}) {
  const quedan = (motivos || []).filter((m) => !MOTIVOS_RESUELTOS_POR_ELECCION.includes(m));
  if (yaContado && !quedan.includes('ya_contado')) quedan.push('ya_contado');
  return quedan;
}

/**
 * Tras elegir, se confirma si queda una regla (ya contado, cálculo, redondeo…)
 * o si falta la cantidad. Un acierto limpio puede aplicarse solo.
 */
export function confirmarTrasElegir(linea, motivos) {
  if (!linea?.productId) return true;
  if (linea.modo !== 'borrar' && (linea.cantidad == null || typeof linea.cantidad.total !== 'number')) return true;
  return (motivos || []).some((m) => PIDEN_CONFIRMAR.has(m));
}
